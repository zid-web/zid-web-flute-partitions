import { isNativeApp } from "./contentSync";

/**
 * Mises à jour de l'application de bureau (Mac, Windows, Linux) : elle cherche elle-même la
 * nouvelle version publiée sur GitHub (Releases, fichier `latest.json` signé), la propose dans
 * la bibliothèque, puis la télécharge, l'installe et redémarre — jamais pendant un morceau.
 * Facultatif : hors ligne, ou si la recherche échoue, rien ne change.
 */

export interface NativeUpdate {
  version: string;
  notes?: string;
  /**
   * Télécharge et installe (avancement 0–1, ou null si la taille est inconnue), puis redémarre.
   * Échec : une `UpdateError` avec un message clair ; « installed » : installée, mais le
   * redémarrage automatique a échoué (il suffit de rouvrir l'application).
   */
  install(onProgress: (fraction: number | null) => void): Promise<void>;
}

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly installed = false,
  ) {
    super(message);
  }
}

/**
 * Problème d'emplacement de l'application (logique pure, testée) : lancée depuis l'image disque
 * (.dmg) ou isolée par macOS parce qu'elle n'a pas été déplacée dans Applications, elle ne peut
 * pas être remplacée par une mise à jour.
 */
export function locationProblem(exePath: string | null): string | null {
  if (!exePath) return null;
  if (exePath.startsWith("/Volumes/"))
    return "L'application est ouverte depuis l'image disque (.dmg) : glissez-la dans le dossier Applications, éjectez le .dmg, puis ouvrez-la depuis Applications.";
  if (exePath.includes("/AppTranslocation/"))
    return "macOS a isolé l'application car elle n'a pas été déplacée dans Applications : glissez-la dans le dossier Applications (avec le Finder), puis ouvrez-la depuis là.";
  return null;
}

/** Message clair pour une erreur du module de mise à jour (logique pure, testée). */
export function updateErrorMessage(error: unknown, exePath: string | null = null): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const where = locationProblem(exePath);
  if (where) return where;
  if (/read-only|lecture seule/i.test(raw)) return "L'application est sur un disque en lecture seule : déplacez-la dans le dossier Applications, puis réessayez.";
  if (/same mount|TempDirNotOnSameMountPoint/i.test(raw)) return "L'application est sur un autre disque que le système : déplacez-la dans le dossier Applications, puis réessayez.";
  if (/permission|not permitted|denied|authoriz/i.test(raw)) return "macOS a refusé de remplacer l'application (autorisation) : téléchargez la nouvelle version et installez-la à la main.";
  if (/signature/i.test(raw)) return "La mise à jour téléchargée n'a pas pu être vérifiée : téléchargez-la à la main.";
  if (/network|connect|timed? ?out|dns|request|fetch|offline/i.test(raw)) return "Téléchargement interrompu : vérifiez la connexion et réessayez.";
  return raw ? `La mise à jour n'a pas pu être installée (${raw}).` : "La mise à jour n'a pas pu être installée.";
}

async function invokeNative<T>(cmd: string): Promise<T | null> {
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
  if (!tauri) return null;
  try {
    return (await tauri.invoke(cmd)) as T;
  } catch {
    return null;
  }
}

/** Chemin de l'application en cours d'exécution (application de bureau). */
export const appLocation = () => invokeNative<string>("app_location");

/** Ouvre la page de téléchargement des versions dans le navigateur. */
export async function openDownloadPage(): Promise<void> {
  await invokeNative("open_download_page");
}

const CHECK_EVERY_MS = 6 * 60 * 60_000;

/** Mobile : les mises à jour passent par la boutique d'applications. */
function isDesktop(): boolean {
  return isNativeApp() && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** Avancement du téléchargement (logique pure, testée). */
export function downloadFraction(downloaded: number, total: number | undefined): number | null {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(1, downloaded / total));
}

export async function checkNativeUpdate(): Promise<NativeUpdate | null> {
  if (!isDesktop() || !navigator.onLine) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      notes: update.body,
      async install(onProgress) {
        let total: number | undefined;
        let downloaded = 0;
        const where = await appLocation();
        const problem = locationProblem(where);
        if (problem) throw new UpdateError(problem);
        try {
          await update.downloadAndInstall((event) => {
            if (event.event === "Started") total = event.data.contentLength;
            else if (event.event === "Progress") {
              downloaded += event.data.chunkLength;
              onProgress(downloadFraction(downloaded, total));
            } else onProgress(1);
          });
        } catch (e) {
          throw new UpdateError(updateErrorMessage(e, where));
        }
        try {
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
        } catch {
          throw new UpdateError(`Version ${update.version} installée : quittez l'application (⌘ Q) et rouvrez-la.`, true);
        }
      },
    };
  } catch {
    // Hors ligne, GitHub indisponible, aucune version signée publiée : on réessaiera plus tard.
    return null;
  }
}

/** Cherche au démarrage, puis toutes les 6 heures ; `onFound` reçoit la nouvelle version. */
export function watchNativeUpdates(onFound: (update: NativeUpdate) => void): () => void {
  if (!isDesktop()) return () => {};
  let stopped = false;
  const run = () =>
    void checkNativeUpdate().then((u) => {
      if (u && !stopped) onFound(u);
    });
  run();
  const timer = window.setInterval(run, CHECK_EVERY_MS);
  window.addEventListener("online", run);
  return () => {
    stopped = true;
    clearInterval(timer);
    window.removeEventListener("online", run);
  };
}
