import type { CatalogEntry } from "./catalog";

/** Ordres de rangement de la bibliothèque. */
export type SortKey = "level" | "recent" | "composer" | "title";

export const SORT_LABELS: Record<SortKey, string> = {
  level: "Niveau",
  recent: "Date d'import",
  composer: "Compositeur",
  title: "Titre",
};

const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });
const byLevel = (a: CatalogEntry, b: CatalogEntry) => a.level - b.level || a.complexity - b.complexity;
const byTitle = (a: CatalogEntry, b: CatalogEntry) => collator.compare(a.title, b.title);
const byComposer = (a: CatalogEntry, b: CatalogEntry) => collator.compare(a.composer, b.composer) || byTitle(a, b);

/** Trie sans modifier la liste reçue. « Date d'import » : partitions importées, les plus récentes d'abord, puis les autres par niveau. */
export function sortEntries(list: CatalogEntry[], key: SortKey): CatalogEntry[] {
  const compare = {
    level: byLevel,
    title: byTitle,
    composer: byComposer,
    recent: (a: CatalogEntry, b: CatalogEntry) => (b.addedAt ?? -1) - (a.addedAt ?? -1) || byLevel(a, b),
  }[key];
  return [...list].sort(compare);
}

/** En-tête de groupe à afficher avant chaque entrée (null = même groupe que la précédente). */
export function groupHeadings(sorted: CatalogEntry[], key: SortKey): (string | null)[] {
  const label = (e: CatalogEntry): string | null => {
    if (key === "composer") return e.composer || "Compositeur inconnu";
    if (key === "recent") return e.addedAt === undefined ? "Bibliothèque" : "Mes partitions importées";
    return null;
  };
  return sorted.map((e, i) => {
    const current = label(e);
    const previous = i === 0 ? null : label(sorted[i - 1]);
    // « Bach » et « bach » : même groupe (même règle que le tri).
    return current !== null && (previous === null || collator.compare(previous, current) !== 0) ? current : null;
  });
}

const STORAGE_KEY = "flute-partitions:sort";

export function loadSortKey(): SortKey {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && v in SORT_LABELS) return v as SortKey;
  } catch {
    // stockage indisponible (navigation privée) : ordre par défaut
  }
  return "level";
}

export function saveSortKey(key: SortKey): void {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // préférence non mémorisée : sans conséquence
  }
}
