/** Une entrée du catalogue généré par le skill `imslp-flute-curator`. */
export interface CatalogEntry {
  id: string;
  title: string;
  composer: string;
  /** 1 (tout débutant) → 5 (avancé). */
  level: 1 | 2 | 3 | 4 | 5;
  /** Score de complexité 0–100 calculé à partir de la partition. */
  complexity: number;
  file: string;
  key?: string;
  time?: string;
  range?: { low: string; high: string };
  noteCount?: number;
  source: string;
  sourceUrl?: string;
  license: string;
  /** "native" = MusicXML d'origine, "omr" = reconnu depuis un PDF puis relu. */
  origin: "native" | "omr" | "original";
  tags?: string[];
}

export const LEVEL_LABELS: Record<CatalogEntry["level"], string> = {
  1: "Découverte",
  2: "Débutant",
  3: "Intermédiaire",
  4: "Confirmé",
  5: "Avancé",
};

export async function loadCatalog(): Promise<CatalogEntry[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}scores/catalog.json`);
  if (!res.ok) throw new Error(`Catalogue introuvable (${res.status})`);
  const data = (await res.json()) as { scores: CatalogEntry[] };
  return data.scores;
}
