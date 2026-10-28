import { registerSW } from "virtual:pwa-register";

/**
 * Mise à jour automatique de l'application web / PWA installée.
 *
 * Vercel publie une nouvelle version à chaque modification de `main`. L'application la cherche
 * au démarrage, toutes les minutes et à chaque retour au premier plan, puis l'installe :
 * - tout de suite si l'élève est dans la bibliothèque ;
 * - sinon au retour à la bibliothèque, pour ne jamais couper un morceau en cours.
 */
const CHECK_EVERY_MS = 60_000;

let busy = false;
let pending: (() => void) | null = null;
const listeners = new Set<(waiting: boolean) => void>();

function notify() {
  listeners.forEach((l) => l(pending !== null));
}

export function initAppUpdates(): void {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      pending = () => void updateSW(true);
      if (busy) notify();
      else pending();
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      const check = () => {
        if (navigator.onLine && registration.installing === null) void registration.update().catch(() => {});
      };
      setInterval(check, CHECK_EVERY_MS);
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
      window.addEventListener("online", check);
    },
  });
}

/** Pendant un morceau, on reporte l'installation ; elle se fait dès que l'élève a fini. */
export function setBusy(value: boolean): void {
  busy = value;
  if (!busy && pending) pending();
}

/** Vrai quand une nouvelle version attend la fin du morceau en cours. */
export function onUpdateWaiting(listener: (waiting: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function applyUpdateNow(): void {
  pending?.();
}
