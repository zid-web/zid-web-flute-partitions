/**
 * Détection de la plateforme d'exécution (Application de bureau locale Tauri vs Web/PWA).
 */

export function isDesktopApp(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPod|iPad/.test(navigator.platform || navigator.userAgent);
}

export function isWindows(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Win/.test(navigator.platform || navigator.userAgent);
}

export function isLinux(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Linux/.test(navigator.platform || navigator.userAgent) && !/Android/.test(navigator.userAgent);
}

export function getPlatformLabel(): string {
  if (!isDesktopApp()) return "Web PWA";
  if (isMac()) return "Bureau (macOS)";
  if (isWindows()) return "Bureau (Windows)";
  if (isLinux()) return "Bureau (Linux)";
  return "Bureau (Local)";
}
