import type { CatalogEntry } from "./catalog";
import { decodeTake, encodeTake, listTakes, saveTake, type StoredTake } from "./myFlute";

/**
 * Partitions importées par l'utilisateur, gardées uniquement sur l'appareil (IndexedDB) :
 * elles restent disponibles hors ligne et ne sont envoyées nulle part.
 */
const DB_NAME = "flute-partitions";
const STORE = "user-scores";

export interface StoredScore {
  entry: CatalogEntry;
  xml: string;
  /** Partie(s) de piano pour l'accompagnement (partitions flûte + piano). */
  accompaniment?: string;
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
    return all.sort((a, b) => b.addedAt - a.addedAt).map((s) => ({ ...s.entry, addedAt: s.addedAt }));
  } catch {
    // Navigation privée / stockage bloqué : pas de partitions personnelles, l'app reste utilisable.
    return [];
  }
}

/** Enregistre la partition et la renvoie avec sa date d'import. */
export async function saveUserScore(entry: CatalogEntry, xml: string, accompaniment?: string): Promise<CatalogEntry> {
  const addedAt = Date.now();
  await run("readwrite", (s) => s.put({ entry, xml, accompaniment, addedAt } satisfies StoredScore));
  return { ...entry, addedAt };
}

export async function deleteUserScore(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}

/** Partie de piano d'une partition importée flûte + piano (null s'il n'y en a pas). */
export async function getUserScoreAccompaniment(id: string): Promise<string | null> {
  const stored = await run<StoredScore | undefined>("readonly", (s) => s.get(id));
  return stored?.accompaniment ?? null;
}

export async function getUserScoreXml(id: string): Promise<string> {
  const stored = await run<StoredScore | undefined>("readonly", (s) => s.get(id));
  if (!stored) throw new Error("Partition importée introuvable sur cet appareil.");
  return stored.xml;
}

/**
 * Demande au navigateur de ne pas effacer ce stockage de lui-même (Safari supprime sinon les
 * données d'un site peu visité ; Chrome peut les libérer quand l'appareil manque de place).
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Fichier de sauvegarde, à garder et à restaurer ailleurs : toutes les partitions importées et,
 * depuis la version 2, les notes enregistrées de « Ma flûte ».
 */
export const BACKUP_FORMAT = "flute-partitions-sauvegarde";

export async function exportUserScores(): Promise<string> {
  const scores = await run<StoredScore[]>("readonly", (s) => s.getAll());
  const takes = (await listTakes()).map(encodeTake);
  return JSON.stringify({ format: BACKUP_FORMAT, version: 2, scores, takes });
}

/** Notes de « Ma flûte » d'un fichier de sauvegarde (aucune dans une sauvegarde de version 1). */
export function parseBackupTakes(text: string): StoredTake[] {
  const backup = JSON.parse(text) as { takes?: unknown };
  return Array.isArray(backup.takes) ? backup.takes.map(decodeTake).filter((t): t is StoredTake => t !== null) : [];
}

/** Vérifie un fichier de sauvegarde et renvoie les partitions qu'il contient. */
export function parseBackup(text: string): StoredScore[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Ce fichier n'est pas une sauvegarde de partitions.");
  }
  const backup = data as { format?: unknown; scores?: unknown };
  if (backup?.format !== BACKUP_FORMAT || !Array.isArray(backup.scores)) {
    throw new Error("Ce fichier n'est pas une sauvegarde de partitions.");
  }
  return backup.scores.filter(
    (s): s is StoredScore =>
      typeof s?.entry?.id === "string" &&
      typeof s?.entry?.title === "string" &&
      typeof s?.xml === "string" &&
      s.xml.includes("score-partwise"),
  ).map((s) => ({
    entry: { ...s.entry, origin: "import" },
    xml: s.xml,
    accompaniment: typeof s.accompaniment === "string" ? s.accompaniment : undefined,
    addedAt: Number(s.addedAt) || Date.now(),
  }));
}

/**
 * Restaure une sauvegarde : les partitions déjà présentes sont remplacées par leur copie, les notes
 * de « Ma flûte » aussi (même note). Renvoie le nombre de partitions et de notes restaurées.
 */
export async function restoreUserScores(text: string): Promise<{ scores: number; takes: number }> {
  const scores = parseBackup(text);
  const takes = parseBackupTakes(text);
  for (const score of scores) await run("readwrite", (s) => s.put(score));
  for (const take of takes) await saveTake(take);
  return { scores: scores.length, takes: takes.length };
}
