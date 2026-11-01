/**
 * Partitions PDF : reconnues par Audiveris installé sur l'ordinateur, dans l'application native
 * (Mac, Windows, Linux) — tout reste sur l'appareil, aucun envoi. Dans le navigateur et sur
 * téléphone, Audiveris ne peut pas tourner : on explique comment convertir le PDF soi-même.
 */
type Invoke = (cmd: string, args?: object) => Promise<unknown>;

function nativeInvoke(): Invoke | null {
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__;
  return tauri ? tauri.invoke.bind(tauri) : null;
}

export const isPdf = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

/** Chemin d'Audiveris sur cet ordinateur, ou null (navigateur, téléphone, ou pas installé). */
export async function audiverisPath(): Promise<string | null> {
  const invoke = nativeInvoke();
  if (!invoke) return null;
  try {
    return ((await invoke("audiveris_path")) as string | null) ?? null;
  } catch {
    return null;
  }
}

export const PDF_HELP_WEB =
  "Les PDF se convertissent dans l'application pour ordinateur (Mac, Windows) avec Audiveris installé. " +
  "Ici, convertissez d'abord le PDF en MusicXML (MuseScore : Fichier › Importer un PDF, ou Audiveris), puis importez le .mxl.";
export const PDF_HELP_NO_AUDIVERIS =
  "Pour lire un PDF, installez Audiveris (gratuit : github.com/Audiveris/audiveris/releases), puis réessayez.";

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(data: string): Uint8Array {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Reconnaît un PDF avec Audiveris : un MusicXML compressé (.mxl) par morceau reconnu. */
export async function convertPdf(file: File): Promise<{ name: string; bytes: Uint8Array }[]> {
  const invoke = nativeInvoke();
  if (!invoke) throw new Error(PDF_HELP_WEB);
  if (!(await audiverisPath())) throw new Error(PDF_HELP_NO_AUDIVERIS);
  const data = toBase64(new Uint8Array(await file.arrayBuffer()));
  const files = (await invoke("convert_pdf", { name: file.name, data })) as { name: string; data: string }[];
  return files.map((f) => ({ name: f.name, bytes: fromBase64(f.data) }));
}
