import { syncedCatalog, syncedScoreXml } from "./contentSync";
import { getUserScoreXml } from "./userScores";

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
  /** "native" = MusicXML d'origine, "omr" = reconnu depuis un PDF puis relu, "import" = fichier de l'utilisateur. */
  origin: "native" | "omr" | "original" | "import";
  tags?: string[];
}

export const LEVEL_LABELS: Record<CatalogEntry["level"], string> = {
  1: "Découverte",
  2: "Débutant",
  3: "Intermédiaire",
  4: "Confirmé",
  5: "Avancé",
};

/** Contenu MusicXML d'un morceau : fichier publié, ou partition importée sur l'appareil. */
export async function loadScoreXml(entry: CatalogEntry): Promise<string> {
  if (entry.origin === "import") return getUserScoreXml(entry.id);
  const synced = await syncedScoreXml(entry.id);
  if (synced) return synced;
  const res = await fetch(`${import.meta.env.BASE_URL}scores/${entry.file}`);
  if (!res.ok) throw new Error(`Partition introuvable (${res.status})`);
  return res.text();
}

/** Catalogue embarqué dans l'application (celui du déploiement ou de l'installeur). */
export async function loadBundledCatalog(): Promise<CatalogEntry[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}scores/catalog.json`);
  if (!res.ok) throw new Error(`Catalogue introuvable (${res.status})`);
  const data = (await res.json()) as { scores: CatalogEntry[] };
  return data.scores;
}

/** Catalogue à afficher : celui synchronisé depuis Vercel (applications natives) s'il existe, sinon l'embarqué. */
export async function loadCatalog(): Promise<{ catalog: CatalogEntry[]; bundled: CatalogEntry[] }> {
  const bundled = await loadBundledCatalog();
  return { catalog: (await syncedCatalog()) ?? bundled, bundled };
}
