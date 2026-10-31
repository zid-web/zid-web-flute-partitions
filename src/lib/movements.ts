import type { CatalogEntry } from "./catalog";

/**
 * Mouvements d'une même œuvre importés en fichiers séparés (« Sonate.mvt1.mxl », « Sonate - 2.mxl »,
 * ou MusicXML avec titre d'œuvre + numéro de mouvement) : l'écoute les enchaîne dans l'ordre,
 * sans qu'il faille les regrouper dans un seul fichier.
 */
export interface Movement {
  work: string;
  number: number;
}

const ROMAN: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12,
};

function movementNumber(s: string): number | null {
  if (/^\d{1,2}$/.test(s)) return Number(s) || null;
  return ROMAN[s.toLowerCase()] ?? null;
}

/** Numéro en tête d'un titre de mouvement : « I. Allegro », « 2 - Adagio », « III Presto ». */
export function leadingNumber(title: string): number | null {
  const m = title.trim().match(/^(\d{1,2}|[IVXivx]{1,4})(?:[.):\-–—]|\s)\s*\S/);
  return m ? movementNumber(m[1]) : null;
}

/** Œuvre et numéro de mouvement d'après un nom de fichier, ou null. */
export function movementFromName(fileName: string): Movement | null {
  const base = fileName.replace(/\.(mxl|musicxml|xml)$/i, "").trim();
  // « Sonate.mvt2 » (Audiveris), « Sonate - Mouvement 2 », « Suite_mov_III »
  let m = base.match(/^(.*?)[\s._-]*\b(?:mvt|mvmt|mov|movt|movement|mouvement|satz|movimento)[\s._-]*(\d{1,2}|[ivx]{1,4})\b/i);
  if (m && m[1].trim()) {
    const number = movementNumber(m[2]);
    if (number) return { work: m[1].trim(), number };
  }
  // « Sonate - 2 », « sonate_3 » (mais pas « Sonate op. 2 », « BWV 1013 »…)
  m = base.match(/^(.*\D)[\s._–—-]+(\d{1,2})$/);
  if (m && !/\b(n[o°º]?|op|opus|bwv|hwv|kv?|d|wq|twv|rv|hob)[\s.]*$/i.test(m[1])) {
    const work = m[1].replace(/[\s._–—-]+$/, "").trim();
    if (work && Number(m[2]) > 0) return { work, number: Number(m[2]) };
  }
  return null;
}

/** Mouvement d'une partition : repéré à l'import, sinon d'après son nom de fichier. */
export function movementOf(entry: CatalogEntry): Movement | null {
  if (entry.work && entry.movement) return { work: entry.work, number: entry.movement };
  return movementFromName(entry.file);
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

/**
 * Tous les mouvements de l'œuvre d'une partition, dans l'ordre (la partition seule s'il n'y en a pas
 * d'autres). Même compositeur, même œuvre, et parmi les partitions importées seulement si elle
 * l'est. Des partitions importées sans numéro mais de même titre (fichiers différents) comptent
 * aussi, dans l'ordre de leur nom de fichier puis d'import.
 */
export function movementsOf(entry: CatalogEntry, all: CatalogEntry[]): CatalogEntry[] {
  const imported = (e: CatalogEntry) => e.origin === "import";
  const key = (e: CatalogEntry) => {
    const m = movementOf(e);
    return `${norm(e.composer)}|${m ? norm(m.work) : `=${norm(e.title)}`}`;
  };
  const k = key(entry);
  const group = all.filter((e) => imported(e) === imported(entry) && key(e) === k);
  if (group.length < 2) return [entry];
  // sans numéro de mouvement : le même fichier importé deux fois n'est pas une suite de mouvements
  if (!movementOf(entry) && (!imported(entry) || new Set(group.map((e) => e.file)).size < group.length)) return [entry];
  const num = (e: CatalogEntry) => movementOf(e)?.number ?? Number.MAX_SAFE_INTEGER;
  return [...group].sort(
    (a, b) => num(a) - num(b) || collator.compare(a.file, b.file) || (a.addedAt ?? 0) - (b.addedAt ?? 0),
  );
}
