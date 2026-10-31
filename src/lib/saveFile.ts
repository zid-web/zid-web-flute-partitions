/**
 * Enregistre un fichier créé par l'application (sauvegarde), selon l'appareil :
 * - applications natives (Tauri) : la WebView ne sait pas télécharger, le fichier est écrit
 *   directement dans Téléchargements (commande `save_backup`) ;
 * - téléphone et tablette : partage système (« Enregistrer dans Fichiers », Drive…) ;
 * - ordinateur (et si le partage échoue) : téléchargement classique, dans Téléchargements
 *   (pas le partage système, qui sur Mac ne propose pas d'enregistrer le fichier).
 * Renvoie une phrase disant où est le fichier, ou null si l'utilisateur a annulé le partage.
 */
export async function saveFile(content: string, name: string, type: string): Promise<string | null> {
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, args: object) => Promise<unknown> } })
    .__TAURI_INTERNALS__;
  if (tauri) {
    const path = String(await tauri.invoke("save_backup", { name, content }));
    return `Fichier enregistré : ${path}`;
  }

  const touch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const file = new File([content], name, { type });
  if (touch && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return `Fichier partagé : ${name} (choisissez « Enregistrer dans Fichiers » pour le garder)`;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return null; // partage annulé
      // partage refusé (geste trop ancien, type de fichier…) : téléchargement classique
    }
  }

  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return `Fichier téléchargé : ${name} (dossier Téléchargements)`;
}
