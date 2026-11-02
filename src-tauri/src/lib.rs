use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// Audiveris installé sur l'ordinateur (reconnaissance des partitions PDF), ou None.
fn find_audiveris() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("AUDIVERIS") {
        candidates.push(PathBuf::from(p));
    }
    if let Some(home) = std::env::var_os("HOME") {
        candidates
            .push(Path::new(&home).join("Applications/Audiveris.app/Contents/MacOS/Audiveris"));
    }
    for p in [
        "/Applications/Audiveris.app/Contents/MacOS/Audiveris",
        r"C:\Program Files\Audiveris\Audiveris.exe",
        r"C:\Program Files\Audiveris\bin\Audiveris.bat",
        "/opt/audiveris/bin/Audiveris",
        "/usr/bin/audiveris",
        "/usr/local/bin/audiveris",
    ] {
        candidates.push(PathBuf::from(p));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for name in ["Audiveris", "audiveris", "Audiveris.bat"] {
                candidates.push(dir.join(name));
            }
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Chemin d'Audiveris, s'il est installé (l'écran d'import propose alors les PDF).
#[tauri::command]
fn audiveris_path() -> Option<String> {
    find_audiveris().map(|p| p.display().to_string())
}

#[derive(serde::Serialize)]
struct OmrFile {
    /// « p003~Ballade.mvt2.mxl » : page du PDF, puis nom donné par Audiveris (morceau).
    name: String,
    /// MusicXML compressé (.mxl), en base64.
    data: String,
}

#[derive(serde::Serialize)]
struct OmrResult {
    files: Vec<OmrFile>,
    /// Nombre de pages du PDF.
    pages: usize,
    /// Pages non reconnues (sautées), ou abandonnées faute de temps.
    failed: Vec<usize>,
    /// Vrai si l'utilisateur a annulé.
    cancelled: bool,
}

/// Lignes du journal d'Audiveris utiles pour suivre l'avancement (pages, étapes, export).
fn is_progress_line(line: &str) -> bool {
    line.contains("StepMonitoring")
        || line.contains("sheets in")
        || line.contains("Book reaching")
        || line.contains("parts along")
        || line.contains("Exporting")
}

/// Demande d'annulation de la conversion en cours (bouton « Annuler » de l'import).
static CANCEL: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn cancel_pdf() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Au-delà, une page est abandonnée (Audiveris bloqué sur un scan illisible) : les autres sont gardées.
const PAGE_TIMEOUT: Duration = Duration::from_secs(6 * 60);

/// Arrête Audiveris et ce qu'il a lancé (Java, xvfb-run sous Linux).
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        // groupe de processus créé au lancement : tout le groupe s'arrête
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(format!("-{}", child.id()))
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Lance Audiveris sur une page (ou sur tout le PDF) ; renvoie false s'il a été arrêté
/// (délai dépassé ou annulation).
fn run_audiveris(
    exe: &Path,
    pdf: &Path,
    out: &Path,
    sheet: Option<usize>,
    on_line: &(dyn Fn(&str) + Sync),
) -> bool {
    let _ = std::fs::create_dir_all(out);
    let mut cmd = if cfg!(target_os = "linux") && std::env::var_os("DISPLAY").is_none() {
        let mut c = Command::new("xvfb-run");
        c.arg("-a").arg(exe);
        c
    } else {
        Command::new(exe)
    };
    cmd.arg("-batch").arg("-export").arg("-output").arg(out);
    if let Some(n) = sheet {
        cmd.arg("-sheets").arg(n.to_string());
    }
    cmd.arg("--")
        .arg(pdf)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let Ok(mut child) = cmd.spawn() else {
        return false;
    };
    let started = Instant::now();
    std::thread::scope(|s| {
        // Journal d'Audiveris lu au fil de l'eau : chaque page et chaque étape font avancer la barre.
        if let Some(stdout) = child.stdout.take() {
            s.spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if is_progress_line(&line) {
                        on_line(&line);
                    }
                }
            });
        }
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return true,
                Ok(None) => {}
                Err(_) => return false,
            }
            if CANCEL.load(Ordering::SeqCst) || started.elapsed() > PAGE_TIMEOUT {
                kill_tree(&mut child);
                return false;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    })
}

fn collect_mxl(dir: &Path, found: &mut Vec<PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect_mxl(&p, found);
            } else if p.extension().is_some_and(|x| x == "mxl") {
                found.push(p);
            }
        }
    }
}

/// Nombre de pages d'un PDF (approximatif : objets « /Type /Page ») ; 0 si inconnu.
fn pdf_page_count(bytes: &[u8]) -> usize {
    let text = String::from_utf8_lossy(bytes);
    (text.matches("/Type /Page").count() + text.matches("/Type/Page").count())
        .saturating_sub(text.matches("/Type /Pages").count() + text.matches("/Type/Pages").count())
}

/// Nombre de pages annoncé par Audiveris (« 9 sheets in … »).
fn sheets_in(line: &str) -> Option<usize> {
    let before = &line[..line.find(" sheets in").or_else(|| line.find(" sheet in"))?];
    before.rsplit(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

/// Nombre d'Audiveris lancés en même temps : chacun utilise déjà plusieurs cœurs, et une page
/// d'orchestre demande beaucoup de mémoire.
fn worker_count(pages: usize) -> usize {
    let cores = std::thread::available_parallelism().map_or(2, |n| n.get());
    (cores / 2).clamp(1, 4).min(pages.max(1))
}

/// Reconnaît une partition PDF avec Audiveris (sur l'ordinateur, hors ligne), page par page,
/// plusieurs pages à la fois. Une page illisible ou trop longue est sautée sans faire échouer les
/// autres ; l'utilisateur peut annuler. Les MusicXML sont rassemblés dans l'application
/// (`src/lib/omrPages.ts`).
#[tauri::command]
async fn convert_pdf(app: tauri::AppHandle, name: String, data: String) -> Result<OmrResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = STANDARD
            .decode(data)
            .map_err(|_| "Fichier PDF illisible.".to_string())?;
        // avancement envoyé à l'écran d'import (événement « omr-progress »)
        convert_pdf_bytes(&name, &bytes, &|line: &str| {
            let _ = app.emit("omr-progress", line.to_string());
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn convert_pdf_bytes(
    name: &str,
    bytes: &[u8],
    on_line: &(dyn Fn(&str) + Sync),
) -> Result<OmrResult, String> {
    CANCEL.store(false, Ordering::SeqCst);
    let exe = find_audiveris().ok_or("Audiveris n'est pas installé sur cet ordinateur.")?;
    let work = std::env::temp_dir().join(format!(
        "flute-omr-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    // nom court et sûr : Audiveris nomme ses sorties d'après le fichier
    let stem: String = Path::new(name)
        .file_stem()
        .map(|s| {
            s.to_string_lossy()
                .chars()
                .filter(|c| c.is_alphanumeric() || "-_".contains(*c))
                .collect()
        })
        .filter(|s: &String| !s.is_empty())
        .unwrap_or_else(|| "partition".into());
    let pdf = work.join(format!("{stem}.pdf"));
    std::fs::write(&pdf, bytes).map_err(|e| e.to_string())?;

    // Nombre de pages : celui d'Audiveris (fiable), lu dès l'ouverture de la première page ;
    // les autres pages attendent de le connaître.
    let total: Mutex<Option<usize>> = Mutex::new(None);
    let known = Condvar::new();
    let next = AtomicUsize::new(1);
    let results: Mutex<Vec<(usize, Vec<PathBuf>)>> = Mutex::new(Vec::new());
    let failed: Mutex<Vec<usize>> = Mutex::new(Vec::new());
    let guess = pdf_page_count(bytes);
    let set_total = |n: usize| {
        let mut t = total.lock().unwrap();
        if t.is_none() {
            *t = Some(n.max(1));
            on_line(&format!("PAGES {}", n.max(1)));
            known.notify_all();
        }
    };
    let workers = worker_count(if guess > 0 { guess } else { 4 });
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                let n = next.fetch_add(1, Ordering::SeqCst);
                let pages = if n == 1 {
                    None
                } else {
                    let mut t = total.lock().unwrap();
                    while t.is_none() {
                        t = known.wait(t).unwrap();
                    }
                    *t
                };
                if pages.is_some_and(|p| n > p) || CANCEL.load(Ordering::SeqCst) {
                    break;
                }
                let out = work.join(format!("p{n:03}"));
                on_line(&format!("PAGE_START {n}"));
                let line = |l: &str| {
                    if n == 1 {
                        if let Some(count) = sheets_in(l) {
                            set_total(count);
                        }
                    }
                    on_line(l);
                };
                let finished = run_audiveris(&exe, &pdf, &out, Some(n), &line);
                // Audiveris n'a rien dit du nombre de pages (PDF très abîmé) : estimation
                if n == 1 {
                    set_total(guess);
                }
                let mut files = Vec::new();
                if finished {
                    collect_mxl(&out, &mut files);
                }
                files.sort();
                if files.is_empty() {
                    if !CANCEL.load(Ordering::SeqCst) {
                        failed.lock().unwrap().push(n);
                    }
                    on_line(&format!("PAGE_DONE {n} fail"));
                } else {
                    on_line(&format!("PAGE_DONE {n} ok"));
                    results.lock().unwrap().push((n, files));
                }
            });
        }
    });

    let cancelled = CANCEL.load(Ordering::SeqCst);
    let pages = total.into_inner().unwrap().unwrap_or(guess);
    let mut results = results.into_inner().unwrap();
    results.sort();
    let files = results
        .iter()
        .flat_map(|(n, paths)| paths.iter().map(move |p| (*n, p)))
        .filter_map(|(n, p)| {
            let data = std::fs::read(p).ok()?;
            Some(OmrFile {
                name: format!("p{n:03}~{}", p.file_name()?.to_string_lossy()),
                data: STANDARD.encode(data),
            })
        })
        .collect::<Vec<_>>();
    let mut failed = failed.into_inner().unwrap();
    failed.sort();
    let _ = std::fs::remove_dir_all(&work);
    if cancelled {
        return Err("Conversion annulée.".into());
    }
    if files.is_empty() {
        return Err("Audiveris n'a reconnu aucune page de cette partition (scan trop abîmé, ou pas de musique).".into());
    }
    Ok(OmrResult {
        files,
        pages,
        failed,
        cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lancé à la main avec un PDF et Audiveris installé : OMR_PDF=chemin cargo test -- --ignored
    #[test]
    #[ignore]
    fn convertit_un_pdf() {
        let path = std::env::var("OMR_PDF").expect("OMR_PDF");
        let bytes = std::fs::read(&path).unwrap();
        let lines = Mutex::new(Vec::<String>::new());
        let started = Instant::now();
        let result = convert_pdf_bytes(&path, &bytes, &|l: &str| {
            lines.lock().unwrap().push(l.to_string())
        })
        .unwrap();
        println!("{} pages en {:?}, sautées : {:?}", result.pages, started.elapsed(), result.failed);
        let files = result.files;
        let lines = lines.into_inner().unwrap();
        println!(
            "{} lignes d'avancement, dernière : {:?}",
            lines.len(),
            lines.last()
        );
        assert!(lines.iter().any(|l| l.starts_with("PAGES ")));
        assert!(lines.iter().any(|l| l.contains("StepMonitoring")));
        for f in &files {
            println!("{} : {} octets (base64)", f.name, f.data.len());
        }
        assert!(!files.is_empty());
    }

    #[test]
    fn lit_le_nombre_de_pages_d_audiveris() {
        assert_eq!(
            sheets_in("INFO  [Ballade]  Book 560  | 9 sheets in /tmp/Ballade.pdf"),
            Some(9)
        );
        assert_eq!(sheets_in("| 1 sheet in x"), Some(1));
        assert_eq!(sheets_in("Exporting sheet"), None);
        assert_eq!(sheets_in("12 sheets in x"), Some(12));
    }

    #[test]
    fn compte_les_pages() {
        let pdf = b"<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type/Page >>";
        assert_eq!(pdf_page_count(pdf), 2);
    }
}

/// Enregistre un fichier de sauvegarde de l'application (partitions importées, notes de « Ma flûte »).
/// Dans les applications natives, la WebView ne sait pas télécharger un fichier : on l'écrit ici,
/// dans Téléchargements (sinon Documents, sinon le dossier de l'application). Renvoie son chemin.
#[tauri::command]
fn save_backup(app: tauri::AppHandle, name: String, content: String) -> Result<String, String> {
    let safe: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || "-_.".contains(*c))
        .collect();
    if safe.is_empty() || safe.starts_with('.') || !safe.ends_with(".json") {
        return Err("Nom de fichier invalide.".into());
    }
    let paths = app.path();
    let mut last = String::from("aucun dossier disponible");
    for dir in [
        paths.download_dir(),
        paths.document_dir(),
        paths.app_data_dir(),
    ]
    .into_iter()
    .flatten()
    {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            last = e.to_string();
            continue;
        }
        let path = dir.join(&safe);
        match std::fs::write(&path, content.as_bytes()) {
            Ok(()) => return Ok(path.display().to_string()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("Sauvegarde impossible : {last}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Mises à jour de l'application de bureau : proposées dans la bibliothèque (src/lib/nativeUpdate.ts).
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    builder
        .invoke_handler(tauri::generate_handler![
            save_backup,
            audiveris_path,
            convert_pdf,
            cancel_pdf
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Flûte Partitions");
}
