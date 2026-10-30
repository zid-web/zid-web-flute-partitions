import JSZip from "jszip";
import type { CatalogEntry } from "./catalog";
import { analyseScore, extractFlutePart, parseMusicXml, scoreWarnings } from "./difficulty";
import { hasFlutePart, keepParts, otherFluteIds, pianoPartIds, type Partner, type ScoreKind } from "./accompaniment";
import { copyTempoMarks, hasTempoMarks, partTempoMap } from "./tempo";

export const ACCEPTED_EXTENSIONS = ".mxl,.musicxml,.xml";

/** Lit un fichier .musicxml / .xml, ou décompresse un .mxl (zip MusicXML). */
export async function readScoreFile(file: Blob): Promise<string> {
  return readScoreBytes(new Uint8Array(await file.arrayBuffer()));
}

export async function readScoreBytes(bytes: Uint8Array): Promise<string> {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // « PK »
  if (!isZip) return new TextDecoder().decode(bytes);

  const zip = await JSZip.loadAsync(bytes);
  const container = await zip.file("META-INF/container.xml")?.async("string");
  let path = container?.match(/full-path="([^"]+)"/)?.[1];
  path ??= Object.keys(zip.files).find((p) => !p.startsWith("META-INF/") && /\.(xml|musicxml)$/i.test(p));
  const entry = path ? zip.file(path) : null;
  if (!entry) throw new Error("Archive .mxl sans partition MusicXML.");
  return entry.async("string");
}

export interface PreparedImport {
  entry: CatalogEntry;
  xml: string;
  /** Partie(s) de piano gardée(s) pour l'accompagnement (partitions flûte + piano). */
  accompaniment?: string;
  warnings: string[];
}

/** Copie ne gardant que certaines parties, avec le tempo de la partition (écrit dans la 1re partie). */
function partsOnly(rawXml: string, ids: string[], tempos: number[]): string {
  const doc = parseMusicXml(rawXml);
  keepParts(doc, ids);
  const first = doc.documentElement.querySelector(":scope > part");
  if (first && !hasTempoMarks(first)) copyTempoMarks(tempos, first);
  return new XMLSerializer().serializeToString(doc);
}

/**
 * Repère les parties : flûte (suivie au micro), piano (accompagnement, ou partition pour piano
 * seul jouée au piano). Calcule niveau et complexité, et prépare l'entrée de bibliothèque.
 */
export function prepareImport(rawXml: string, fileName: string): PreparedImport {
  const doc = parseMusicXml(rawXml);
  const firstPart = doc.documentElement.querySelector(":scope > part");
  const tempos = firstPart ? partTempoMap(firstPart) : [];
  const pianos = pianoPartIds(doc);
  let kind: ScoreKind;
  let accompaniment: string | undefined;
  let partners: Partner[] = [];
  // Une partition dont toutes les parties sont pour piano (même une seule : « Piano », ou écrite
  // sur deux portées) n'est pas une partition de flûte, sauf si une partie s'appelle flûte.
  const allPiano = pianos.length > 0 && pianos.length === doc.documentElement.querySelectorAll(":scope > part").length;
  if (!(allPiano && !hasFlutePart(doc)) && extractFlutePart(doc)) {
    const flute = doc.documentElement.querySelector(":scope > part");
    if (flute && !hasTempoMarks(flute)) copyTempoMarks(tempos, flute);
    const keptId = flute?.getAttribute("id") ?? "";
    // Gardés pour être joués par l'application : le piano, et la 2ᵉ flûte d'un duo
    // (l'élève joue la 1ʳᵉ flûte, la première partie nommée flûte).
    const otherPianos = pianos.filter((id) => id !== keptId);
    const otherFlutes = otherFluteIds(parseMusicXml(rawXml), keptId);
    partners = [...(otherPianos.length ? ["piano" as const] : []), ...(otherFlutes.length ? ["flute" as const] : [])];
    kind = otherPianos.length ? "flute-piano" : "flute";
    if (partners.length) accompaniment = partsOnly(rawXml, [...otherPianos, ...otherFlutes], tempos);
  } else if (pianos.length) {
    kind = "piano";
    keepParts(doc, pianos);
    const first = doc.documentElement.querySelector(":scope > part");
    if (first && !hasTempoMarks(first)) copyTempoMarks(tempos, first);
  } else {
    throw new Error("Aucune partie de flûte ni de piano trouvée dans cette partition.");
  }
  const a = analyseScore(doc);
  const xml = new XMLSerializer().serializeToString(doc);
  const fallbackTitle = fileName.replace(/\.(mxl|musicxml|xml)$/i, "");
  const title = a.title === "Sans titre" ? fallbackTitle : a.title;
  return {
    xml,
    accompaniment,
    // une partition pour piano n'est pas suivie au micro : pas d'avertissement de tessiture de flûte
    warnings: kind === "piano" ? [] : scoreWarnings(a),
    entry: {
      id: `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      composer: a.composer,
      level: a.level,
      complexity: a.complexity,
      file: fileName,
      key: `${a.key} majeur`,
      time: a.time,
      range: { low: a.low, high: a.high },
      noteCount: a.noteCount,
      source: "Importée sur cet appareil",
      license: "Fichier personnel",
      origin: "import",
      kind,
      ...(partners.length ? { partners } : {}),
      tags: [
        "importée",
        ...(kind === "piano" ? ["piano seul"] : []),
        ...(partners.includes("piano") ? ["avec piano"] : []),
        ...(partners.includes("flute") ? ["duo de flûtes"] : []),
      ],
    },
  };
}
