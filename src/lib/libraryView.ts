import type { CatalogEntry } from "./catalog";
import { movementOf, movementsOf } from "./movements";

/** Une carte de la bibliothèque : un morceau, ou une œuvre en plusieurs mouvements. */
export interface LibraryItem {
  key: string;
  /** Mouvements dans l'ordre (un seul élément pour un morceau simple). */
  entries: CatalogEntry[];
  /** Titre de l'œuvre (sans le titre du mouvement). */
  title: string;
}

/** Titre d'un mouvement dans sa carte d'œuvre : « Allegro » plutôt que « Sonate – Allegro ». */
export function movementLabel(entry: CatalogEntry, work: string, index: number): string {
  const rest = entry.title.startsWith(work) ? entry.title.slice(work.length).replace(/^\s*[–—:-]\s*/, "") : entry.title;
  return `${index + 1}. ${rest || `Mouvement ${index + 1}`}`;
}

/**
 * Regroupe les mouvements d'une même œuvre en une seule carte, à la place du premier d'entre eux
 * dans l'ordre affiché ; les autres morceaux restent seuls. Seuls les mouvements affichés
 * (après filtres et recherche) sont dans la carte.
 */
export function groupWorks(shown: CatalogEntry[], all: CatalogEntry[]): LibraryItem[] {
  const visible = new Set(shown.map((e) => e.id));
  const placed = new Set<string>();
  const items: LibraryItem[] = [];
  for (const e of shown) {
    if (placed.has(e.id)) continue;
    const group = movementsOf(e, all).filter((m) => visible.has(m.id));
    for (const m of group) placed.add(m.id);
    if (group.length < 2) {
      items.push({ key: e.id, entries: [e], title: e.title });
      continue;
    }
    const work = movementOf(group[0])?.work ?? commonPrefix(group.map((m) => m.title));
    items.push({ key: `oeuvre:${group[0].id}`, entries: group, title: work || group[0].title });
  }
  return items;
}

function commonPrefix(titles: string[]): string {
  let p = titles[0] ?? "";
  for (const t of titles) while (!t.startsWith(p)) p = p.slice(0, -1);
  return p.replace(/[\s–—:-]+$/, "").trim();
}
