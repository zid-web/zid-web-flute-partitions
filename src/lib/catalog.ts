import { syncedAccompanimentXml, syncedCatalog, syncedScoreXml } from "./contentSync";
import { foldToFluteRange } from "./fluteRange";
import { getUserScoreAccompaniment, getUserScoreXml } from "./userScores";

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
  /** Instruments : flûte seule (par défaut), flûte + piano (accompagnement), ou piano seul. */
  kind?: "flute" | "flute-piano" | "piano";
  /** Joués par l'application avec l'élève : piano et/ou 2ᵉ flûte (duo). */
  partners?: ("piano" | "flute")[];
  /** Bibliothèque : fichier des parties d'accompagnement (`<id>.accomp.musicxml`). */
  accompanimentFile?: string;
  /** Partitions importées seulement : date d'import (ms), pour les ranger par ordre d'import. */
  addedAt?: number;
  /** Partitions importées : œuvre et numéro du mouvement, pour enchaîner les mouvements à l'écoute. */
  work?: string;
  movement?: number;
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
  if (entry.origin === "import") {
    const xml = await getUserScoreXml(entry.id);
    return entry.kind === "piano" ? xml : withPlayableOctaves(xml);
  }
  const synced = await syncedScoreXml(entry.id);
  if (synced) return synced;
  const res = await fetch(`${import.meta.env.BASE_URL}scores/${entry.file}`);
  if (!res.ok) throw new Error(`Partition introuvable (${res.status})`);
  return res.text();
}

/**
 * Partitions importées avant la correction automatique de tessiture : les notes injouables à la
 * flûte sont ramenées à l'octave jouable à l'ouverture (le fichier enregistré n'est pas modifié).
 */
export function withPlayableOctaves(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const part = doc.documentElement.querySelector(":scope > part");
  if (!part || doc.getElementsByTagName("parsererror").length || foldToFluteRange(part) === 0) return xml;
  return new XMLSerializer().serializeToString(doc);
}

/**
 * Parties jouées par l'application avec l'élève (piano, 2ᵉ flûte), ou null s'il n'y en a pas.
 * Partition importée : sur l'appareil ; bibliothèque : téléchargée (application native) ou embarquée.
 */
export async function loadAccompanimentXml(entry: CatalogEntry): Promise<string | null> {
  if (entry.origin === "import") return getUserScoreAccompaniment(entry.id);
  if (!entry.accompanimentFile) return null;
  const synced = await syncedAccompanimentXml(entry.id);
  if (synced) return synced;
  const res = await fetch(`${import.meta.env.BASE_URL}scores/${entry.accompanimentFile}`);
  return res.ok ? res.text() : null;
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
