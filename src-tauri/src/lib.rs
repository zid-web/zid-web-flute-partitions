use tauri::Manager;

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
    for dir in [paths.download_dir(), paths.document_dir(), paths.app_data_dir()]
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
        .invoke_handler(tauri::generate_handler![save_backup])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Flûte Partitions");
}
