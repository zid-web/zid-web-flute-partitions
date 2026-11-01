use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
    name: String,
    /// MusicXML compressé (.mxl), en base64.
    data: String,
}

/// Lignes du journal d'Audiveris utiles pour suivre l'avancement (pages, étapes, export).
fn is_progress_line(line: &str) -> bool {
    line.contains("StepMonitoring")
        || line.contains("sheets in")
        || line.contains("Book reaching")
        || line.contains("Exporting")
}

fn run_audiveris(exe: &Path, pdf: &Path, out: &Path, sheet: Option<usize>, on_line: &dyn Fn(&str)) {
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
    let Ok(mut child) = cmd.spawn() else {
        return;
    };
    // Journal d'Audiveris lu au fil de l'eau : chaque page et chaque étape font avancer la barre.
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if is_progress_line(&line) {
                on_line(&line);
            }
        }
    }
    let _ = child.wait();
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
    text.matches("/Type /Page").count() - text.matches("/Type /Pages").count()
        + text.matches("/Type/Page").count()
        - text.matches("/Type/Pages").count()
}

/// Reconnaît une partition PDF avec Audiveris (sur l'ordinateur, hors ligne) et renvoie les
/// MusicXML obtenus (un par morceau). Si l'export du fichier entier échoue (page de titre, scan
/// abîmé…), recommence page par page et garde les pages réussies.
#[tauri::command]
async fn convert_pdf(
    app: tauri::AppHandle,
    name: String,
    data: String,
) -> Result<Vec<OmrFile>, String> {
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
    on_line: &dyn Fn(&str),
) -> Result<Vec<OmrFile>, String> {
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

    let mut found = Vec::new();
    run_audiveris(&exe, &pdf, &work.join("tout"), None, on_line);
    collect_mxl(&work.join("tout"), &mut found);
    if found.is_empty() {
        let pages = pdf_page_count(bytes).clamp(1, 60);
        for n in 1..=pages {
            let out = work.join(format!("page{n:02}"));
            // reprise page par page : l'écran repart de la page n sur le total
            on_line(&format!("RUN {n}/{pages}"));
            run_audiveris(&exe, &pdf, &out, Some(n), on_line);
            let before = found.len();
            collect_mxl(&out, &mut found);
            // renommer par page, pour l'ordre des morceaux
            for f in found.iter_mut().skip(before) {
                let renamed = out.join(format!(
                    "{stem}.page{n:02}{}",
                    f.file_name()
                        .map(|s| s.to_string_lossy().replacen(&stem, "", 1))
                        .unwrap_or_default()
                ));
                if std::fs::rename(&*f, &renamed).is_ok() {
                    *f = renamed;
                }
            }
        }
    }
    found.sort();
    let files = found
        .iter()
        .filter_map(|p| {
            let data = std::fs::read(p).ok()?;
            Some(OmrFile {
                name: p.file_name()?.to_string_lossy().into_owned(),
                data: STANDARD.encode(data),
            })
        })
        .collect::<Vec<_>>();
    let _ = std::fs::remove_dir_all(&work);
    if files.is_empty() {
        return Err("Audiveris n'a reconnu aucune page de cette partition (scan trop abîmé, ou pas de musique).".into());
    }
    Ok(files)
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
        let lines = std::cell::RefCell::new(Vec::new());
        let files = convert_pdf_bytes(&path, &bytes, &|l: &str| {
            lines.borrow_mut().push(l.to_string())
        })
        .unwrap();
        let lines = lines.into_inner();
        println!(
            "{} lignes d'avancement, dernière : {:?}",
            lines.len(),
            lines.last()
        );
        assert!(lines.iter().any(|l| l.contains("sheets in")));
        assert!(lines.iter().any(|l| l.contains("StepMonitoring")));
        for f in &files {
            println!("{} : {} octets (base64)", f.name, f.data.len());
        }
        assert!(!files.is_empty());
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
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_backup,
            audiveris_path,
            convert_pdf
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Flûte Partitions");
}
