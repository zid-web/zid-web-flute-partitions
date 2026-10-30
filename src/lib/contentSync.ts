import type { CatalogEntry } from "./catalog";

/**
 * Applications natives (Tauri) : le code et les partitions sont embarqués dans l'installeur,
 * donc figés à sa version. Quand l'appareil est en ligne, on récupère le catalogue publié sur
 * Vercel et les nouvelles partitions, gardés sur l'appareil : elles restent jouables hors ligne.
 * La version web n'en a pas besoin (même origine que Vercel, mise à jour par le service worker).
 */
export const CONTENT_URL = (import.meta.env.VITE_CONTENT_URL as string | undefined) ?? "https://zid-web-flute-partitions.vercel.app";
const SYNC_EVERY_MS = 30 * 60_000;

export function isNativeApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Empreinte d'une entrée : si elle change, la partition est retéléchargée. */
export function signature(e: CatalogEntry): string {
  const base = [e.file, e.title, e.composer, e.level, e.complexity, e.noteCount, e.license];
  // L'accompagnement n'entre dans l'empreinte que s'il existe : pas de re-téléchargement des autres morceaux.
  return JSON.stringify(e.accompanimentFile ? [...base, e.accompanimentFile] : base);
}

export interface SyncPlan {
  /** Partitions à télécharger (nouvelles ou modifiées). */
  download: CatalogEntry[];
  /** Identifiants retirés du catalogue publié. */
  removed: string[];
  /** Morceaux absents du catalogue embarqué (pour annoncer les nouveautés). */
  added: CatalogEntry[];
}

/** Logique pure : que faut-il télécharger, d'après le catalogue publié et ce qu'on a déjà ? */
export function planSync(bundled: CatalogEntry[], remote: CatalogEntry[], stored: Record<string, string>): SyncPlan {
  const bundledSig = new Map(bundled.map((e) => [e.id, signature(e)]));
  const remoteIds = new Set(remote.map((e) => e.id));
  return {
    download: remote.filter((e) => bundledSig.get(e.id) !== signature(e) && stored[e.id] !== signature(e)),
    removed: Object.keys(stored).filter((id) => !remoteIds.has(id)),
    added: remote.filter((e) => !bundledSig.has(e.id)),
  };
}

/** Entrées du catalogue publié dont la partition est disponible hors ligne. */
export function availableEntries(bundled: CatalogEntry[], remote: CatalogEntry[], stored: Record<string, string>): CatalogEntry[] {
  const bundledSig = new Map(bundled.map((e) => [e.id, signature(e)]));
  return remote.filter((e) => bundledSig.get(e.id) === signature(e) || stored[e.id] === signature(e));
}

// --- Stockage (IndexedDB) -------------------------------------------------------
const DB_NAME = "flute-content";
const SCORES = "scores";
const META = "meta";

interface StoredScore {
  id: string;
  signature: string;
  xml: string;
  /** Piano et/ou 2ᵉ flûte, quand le morceau en a. */
  accompaniment?: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(SCORES, { keyPath: "id" });
      req.result.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Stockage local indisponible."));
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("Erreur du stockage local."));
    });
  } finally {
    db.close();
  }
}

/** Catalogue publié synchronisé, ou null s'il n'y en a pas encore. */
export async function syncedCatalog(): Promise<CatalogEntry[] | null> {
  if (!isNativeApp()) return null;
  try {
    return (await tx<CatalogEntry[] | undefined>(META, "readonly", (s) => s.get("catalog"))) ?? null;
  } catch {
    return null;
  }
}

/** Partition téléchargée lors d'une synchronisation, ou null (alors : version embarquée). */
export async function syncedScoreXml(id: string): Promise<string | null> {
  if (!isNativeApp()) return null;
  try {
    return (await tx<StoredScore | undefined>(SCORES, "readonly", (s) => s.get(id)))?.xml ?? null;
  } catch {
    return null;
  }
}

/** Accompagnement d'un morceau téléchargé (null si absent ou hors application native). */
export async function syncedAccompanimentXml(id: string): Promise<string | null> {
  if (!isNativeApp()) return null;
  try {
    return (await tx<StoredScore | undefined>(SCORES, "readonly", (s) => s.get(id)))?.accompaniment ?? null;
  } catch {
    return null;
  }
}

/** Synchronise le contenu ; renvoie le nouveau catalogue si quelque chose a changé. */
export async function syncContent(bundled: CatalogEntry[]): Promise<{ catalog: CatalogEntry[]; added: CatalogEntry[] } | null> {
  if (!isNativeApp() || !navigator.onLine) return null;
  const res = await fetch(`${CONTENT_URL}/scores/catalog.json`, { cache: "no-store" });
  if (!res.ok) return null;
  const remote = ((await res.json()) as { scores: CatalogEntry[] }).scores;
  const storedList = await tx<StoredScore[]>(SCORES, "readonly", (s) => s.getAll());
  const stored = Object.fromEntries(storedList.map((s) => [s.id, s.signature]));
  const plan = planSync(bundled, remote, stored);

  for (const entry of plan.download) {
    const r = await fetch(`${CONTENT_URL}/scores/${entry.file}`, { cache: "no-store" });
    if (!r.ok) continue; // réessayé à la prochaine synchronisation
    const xml = await r.text();
    let accompaniment: string | undefined;
    if (entry.accompanimentFile) {
      const a = await fetch(`${CONTENT_URL}/scores/${entry.accompanimentFile}`, { cache: "no-store" });
      if (!a.ok) continue; // morceau incomplet : réessayé à la prochaine synchronisation
      accompaniment = await a.text();
    }
    await tx(SCORES, "readwrite", (s) =>
      s.put({ id: entry.id, signature: signature(entry), xml, accompaniment } satisfies StoredScore),
    );
    stored[entry.id] = signature(entry);
  }
  for (const id of plan.removed) await tx(SCORES, "readwrite", (s) => s.delete(id));

  // On n'affiche que les morceaux réellement jouables sur l'appareil (embarqués ou téléchargés).
  const catalog = availableEntries(bundled, remote, stored);
  const previous = await syncedCatalog();
  await tx(META, "readwrite", (s) => s.put(catalog, "catalog"));
  const changed = JSON.stringify(previous ?? bundled) !== JSON.stringify(catalog);
  const added = catalog.filter((e) => !(previous ?? bundled).some((p) => p.id === e.id));
  return changed ? { catalog, added } : null;
}

/** Synchronise au démarrage, toutes les 30 minutes et au retour du réseau. */
export function startContentSync(
  bundled: CatalogEntry[],
  onChange: (catalog: CatalogEntry[], added: CatalogEntry[]) => void,
): () => void {
  if (!isNativeApp()) return () => {};
  const run = () =>
    void syncContent(bundled)
      .then((r) => r && onChange(r.catalog, r.added))
      .catch(() => {}); // hors ligne ou serveur indisponible : on garde le contenu actuel
  run();
  const timer = setInterval(run, SYNC_EVERY_MS);
  window.addEventListener("online", run);
  return () => {
    clearInterval(timer);
    window.removeEventListener("online", run);
  };
}
