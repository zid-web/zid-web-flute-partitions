import type { CatalogEntry } from "./catalog";

/**
 * Partitions importées par l'utilisateur, gardées uniquement sur l'appareil (IndexedDB) :
 * elles restent disponibles hors ligne et ne sont envoyées nulle part.
 */
const DB_NAME = "flute-partitions";
const STORE = "user-scores";

interface StoredScore {
  entry: CatalogEntry;
  xml: string;
  addedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "entry.id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Stockage local indisponible."));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("Erreur du stockage local."));
    });
  } finally {
    db.close();
  }
}

export async function listUserScores(): Promise<CatalogEntry[]> {
  try {
    const all = await run<StoredScore[]>("readonly", (s) => s.getAll());
    return all.sort((a, b) => b.addedAt - a.addedAt).map((s) => s.entry);
  } catch {
    // Navigation privée / stockage bloqué : pas de partitions personnelles, l'app reste utilisable.
    return [];
  }
}

export async function saveUserScore(entry: CatalogEntry, xml: string): Promise<void> {
  await run("readwrite", (s) => s.put({ entry, xml, addedAt: Date.now() } satisfies StoredScore));
}

export async function deleteUserScore(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}

export async function getUserScoreXml(id: string): Promise<string> {
  const stored = await run<StoredScore | undefined>("readonly", (s) => s.get(id));
  if (!stored) throw new Error("Partition importée introuvable sur cet appareil.");
  return stored.xml;
}
