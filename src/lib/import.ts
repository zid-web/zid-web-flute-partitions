import JSZip from "jszip";
import type { CatalogEntry } from "./catalog";
import { analyseScore, extractFlutePart, parseMusicXml, scoreWarnings } from "./difficulty";
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
  warnings: string[];
}

/** Garde la partie de flûte, calcule niveau et complexité, et prépare l'entrée de bibliothèque. */
export function prepareImport(rawXml: string, fileName: string): PreparedImport {
  const doc = parseMusicXml(rawXml);
  const firstPart = doc.documentElement.querySelector(":scope > part");
  const tempos = firstPart ? partTempoMap(firstPart) : [];
  if (!extractFlutePart(doc)) {
    throw new Error("Aucune partie de flûte trouvée : la partition contient plusieurs instruments sans flûte.");
  }
  const flute = doc.documentElement.querySelector(":scope > part");
  if (flute && !hasTempoMarks(flute)) copyTempoMarks(tempos, flute);
  const a = analyseScore(doc);
  const xml = new XMLSerializer().serializeToString(doc);
  const fallbackTitle = fileName.replace(/\.(mxl|musicxml|xml)$/i, "");
  const title = a.title === "Sans titre" ? fallbackTitle : a.title;
  return {
    xml,
    warnings: scoreWarnings(a),
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
      tags: ["importée"],
    },
  };
}
