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
  /** Télécharge et installe (avancement 0–1, ou null si la taille est inconnue), puis redémarre. */
  install(onProgress: (fraction: number | null) => void): Promise<void>;
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
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") total = event.data.contentLength;
          else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            onProgress(downloadFraction(downloaded, total));
          } else onProgress(1);
        });
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
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
