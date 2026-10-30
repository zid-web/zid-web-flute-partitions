/**
 * Enregistre un fichier créé par l'application : partage système (téléphones, applications
 * natives, qui ne gèrent pas toujours les téléchargements), sinon téléchargement classique.
 */
export async function saveFile(content: string, name: string, type: string): Promise<void> {
  const file = new File([content], name, { type });
  if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return; // partage annulé
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
