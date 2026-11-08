import JSZip from "jszip";
import type { CatalogEntry } from "./catalog";
import { analyseScore, extractFlutePart, parseMusicXml, scoreWarnings } from "./difficulty";
import {
  appendFlute2,
  hasFlutePart,
  keepParts,
  otherFluteIds,
  pianoPartIds,
  splitFluteVoices,
  type Partner,
  type ScoreKind,
} from "./accompaniment";
import { foldToFluteRange } from "./fluteRange";
import { leadingNumber, movementFromName } from "./movements";
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
function partsOnly(rawXml: string, ids: string[], tempos: number[]): Document {
  const doc = parseMusicXml(rawXml);
  keepParts(doc, ids);
  const first = doc.documentElement.querySelector(":scope > part");
  if (first && !hasTempoMarks(first)) copyTempoMarks(tempos, first);
  return doc;
}

/**
 * Repère les parties : flûte (suivie au micro), piano (accompagnement, ou partition pour piano
 * seul jouée au piano). Calcule niveau et complexité, et prépare l'entrée de bibliothèque.
 */
/** Œuvre, titre et numéro du mouvement : MusicXML (titre d'œuvre, de mouvement, numéro), sinon nom du fichier. */
function movementInfo(doc: Document, fileName: string): { work?: string; movement?: number; title?: string } {
  const root = doc.documentElement;
  const read = (sel: string) => root.querySelector(sel)?.textContent?.trim() || undefined;
  const workTitle = read(":scope > work > work-title");
  const movementTitle = read(":scope > movement-title");
  const fromName = movementFromName(fileName);
  const written = Number(read(":scope > movement-number"));
  const number =
    (Number.isInteger(written) && written > 0 ? written : null) ??
    fromName?.number ??
    (workTitle && movementTitle ? leadingNumber(movementTitle) : null);
  // « Sonate en mi mineur – II. Allegro » plutôt que le seul titre de l'œuvre, commun à tous les mouvements
  const title = workTitle && movementTitle && movementTitle !== workTitle ? `${workTitle} – ${movementTitle}` : undefined;
  const work = (number && (workTitle ?? fromName?.work)) || undefined;
  return { ...(work && number ? { work, movement: number } : {}), ...(title ? { title } : {}) };
}

/** Noms de parties donnés par un logiciel de reconnaissance (Audiveris : « Voice »), sans instrument. */
const GENERIC_PART = /^\s*(voice|voix|part|partie|staff|portée|instrument|p)?\s*\d*\s*$/i;

/**
 * Partition reconnue depuis un PDF (Audiveris) : aucune partie ne s'appelle « flûte », elles
 * s'appellent « Voice », et quand le nombre de portées change d'un système à l'autre (piano sur
 * trois portées), Audiveris range les portées dans des parties différentes selon le système.
 * Remise en ordre, système par système : la flûte est la première partie « Voice » qui a des notes
 * dans le système ; les autres deviennent des parties de piano. La flûte est nettoyée (une seule
 * voix, mesures complètes) pour l'affichage. Renvoie true si la partition a été remise en ordre.
 */
/**
 * Partie reconnue qui ressemble à une flûte : une seule portée, clés de sol uniquement, et
 * presque toutes ses notes dans la tessiture de la flûte (Si3–Ré7), plutôt aiguës (médiane ≥ La4),
 * jouées une à une (presque pas d'accords).
 */
export function isFluteLike(part: Element, noPianoInScore = false): boolean {
  if (Array.from(part.getElementsByTagName("staves")).some((s) => Number(s.textContent) >= 2)) return false;
  const clefs = Array.from(part.getElementsByTagName("clef")).map((c) => c.querySelector(":scope > sign")?.textContent?.trim());
  if (clefs.some((c) => c && c !== "G")) return false;
  const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const midis = Array.from(part.getElementsByTagName("pitch")).map((p) => {
    const step = p.querySelector(":scope > step")?.textContent?.trim() ?? "C";
    return (Number(p.querySelector(":scope > octave")?.textContent) + 1) * 12 + (STEP[step] ?? 0) + Number(p.querySelector(":scope > alter")?.textContent ?? 0);
  }).filter(Number.isFinite);
  if (midis.length < 4) return false;
  const inRange = midis.filter((m) => m >= 59 && m <= 98).length / midis.length;
  const sorted = [...midis].sort((a, b) => a - b);
  // la flûte joue une note à la fois (peu d'accords), et plutôt dans l'aigu (médiane ≥ La4)
  const chords = part.getElementsByTagName("chord").length / midis.length;
  // aucune clé de fa dans toute la partition : pas de piano possible, la tessiture suffit
  return inRange >= 0.9 && (noPianoInScore || sorted[sorted.length >> 1] >= 69) && chords < 0.1;
}

export function adoptOmrFlute(doc: Document): boolean {
  const root = doc.documentElement;
  const parts = Array.from(root.querySelectorAll(":scope > part"));
  if (parts.length < 2 || hasFlutePart(doc)) return false;
  const pianos = new Set(pianoPartIds(doc));
  const idOf = (p: Element) => p.getAttribute("id") ?? "";
  const nameOf = new Map(
    Array.from(root.querySelectorAll("part-list > score-part")).map((sp) => [idOf(sp), sp.querySelector("part-name")?.textContent ?? ""]),
  );
  const generic = parts.filter((p) => !pianos.has(idOf(p)) && GENERIC_PART.test(nameOf.get(idOf(p)) ?? ""));
  if (generic.length === 0 || generic.length + pianos.size !== parts.length) return false;

  const kids = (el: Element, name: string) => Array.from(el.children).filter((c) => c.localName === name);
  const measuresOf = (p: Element) => new Map(kids(p, "measure").map((m) => [m.getAttribute("number") ?? "", m]));
  const byPart = new Map(parts.map((p) => [idOf(p), measuresOf(p)]));
  const order = kids(parts[0], "measure").map((m) => m.getAttribute("number") ?? "");
  const pitched = (m: Element | undefined) => !!m && m.getElementsByTagName("pitch").length > 0;

  // Systèmes (sauts de ligne ou de page de la première partie) et attributs en vigueur, par partie.
  const systemOf = new Map<string, number>();
  let system = -1;
  for (const m of kids(parts[0], "measure")) {
    const print = kids(m, "print")[0];
    if (system < 0 || print?.getAttribute("new-system") === "yes" || print?.getAttribute("new-page") === "yes") system++;
    systemOf.set(m.getAttribute("number") ?? "", system);
  }
  const attrs = new Map<string, Map<string, { divisions: number; beats: number; beatType: number }>>();
  for (const p of parts) {
    const state = { divisions: 1, beats: 4, beatType: 4 };
    const per = new Map<string, typeof state>();
    for (const m of kids(p, "measure")) {
      const a = kids(m, "attributes")[0];
      const d = Number(a?.querySelector(":scope > divisions")?.textContent);
      if (d > 0) state.divisions = d;
      const b = Number(a?.querySelector(":scope > time > beats")?.textContent);
      const bt = Number(a?.querySelector(":scope > time > beat-type")?.textContent);
      if (b > 0 && bt > 0) Object.assign(state, { beats: b, beatType: bt });
      per.set(m.getAttribute("number") ?? "", { ...state });
    }
    attrs.set(idOf(p), per);
  }

  // Dans chaque système, la flûte : la portée du haut, c.-à-d. la première partie générique
  // réellement gravée dans ce système. Audiveris donne une largeur (`width`) aux mesures lues sur
  // la page, pas à celles qu'il ajoute pour les parties absentes du système ; sans cette
  // information, la première partie générique qui a des notes.
  const engraved = (m: Element | undefined) => !!m && (m.hasAttribute("width") || !!m.querySelector("note[default-x]"));
  const hasLayout = generic.some((p) => kids(p, "measure").some((m) => m.hasAttribute("width")));
  const inSystem = (p: Element, s: number, test: (m: Element | undefined) => boolean) =>
    order.some((n) => systemOf.get(n) === s && test(byPart.get(idOf(p))?.get(n)));
  const fluteOf = new Map<number, string>();
  for (const num of order) {
    const s = systemOf.get(num) ?? 0;
    if (fluteOf.has(s)) continue;
    const found = generic.find((p) => inSystem(p, s, hasLayout ? engraved : pitched));
    fluteOf.set(s, found ? idOf(found) : "");
  }

  const el = (name: string, textContent?: string) => {
    const e = doc.createElementNS(root.namespaceURI, name);
    if (textContent !== undefined) e.textContent = textContent;
    return e;
  };
  const restMeasure = (num: string, like: string) => {
    const a = attrs.get(like)?.get(num) ?? attrs.get(idOf(parts[0]))?.get(num) ?? { divisions: 1, beats: 4, beatType: 4 };
    const m = el("measure");
    m.setAttribute("number", num);
    const at = el("attributes");
    at.append(el("divisions", String(a.divisions)));
    m.append(at);
    const note = el("note");
    const rest = el("rest");
    rest.setAttribute("measure", "yes");
    note.append(rest, el("duration", String(Math.round((a.beats * 4 * a.divisions) / a.beatType))), el("voice", "1"));
    m.append(note);
    return m;
  };
  /** Mesure de la flûte : une seule voix (la plus fournie), pas de saut arrière, divisions en tête. */
  const cleanFluteMeasure = (src: Element, from: string, num: string, clef: boolean) => {
    const m = src.cloneNode(true) as Element;
    for (const x of [...kids(m, "print"), ...kids(m, "backup"), ...kids(m, "forward")]) x.remove();
    // lignes d'octave et crochets de reprise : souvent ceux du piano, rattachés par erreur (et une
    // ligne d'octave sans fin dans la même partie bloque l'affichage)
    for (const d of kids(m, "direction")) if (d.getElementsByTagName("octave-shift").length) d.remove();
    for (const e of Array.from(m.getElementsByTagName("ending"))) e.remove();
    for (const st of Array.from(m.getElementsByTagName("staff"))) st.remove();
    const notes = kids(m, "note");
    const count = new Map<string, number>();
    for (const n of notes) {
      const v = n.querySelector(":scope > voice")?.textContent ?? "1";
      count.set(v, (count.get(v) ?? 0) + 1);
    }
    const main = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "1";
    for (const n of notes) {
      const v = n.querySelector(":scope > voice");
      if ((v?.textContent ?? "1") !== main) n.remove();
      else if (v) v.textContent = "1";
      n.querySelector(":scope > staff")?.remove();
    }
    if (kids(m, "note").length === 0) return restMeasure(num, from);
    let a = kids(m, "attributes")[0];
    if (!a) {
      a = el("attributes");
      m.insertBefore(a, m.firstChild);
    }
    for (const c of kids(a, "clef")) c.remove();
    for (const st of kids(a, "staves")) st.remove();
    if (!kids(a, "divisions").length) a.insertBefore(el("divisions", String(attrs.get(from)?.get(num)?.divisions ?? 1)), a.firstChild);
    if (clef) {
      const c = el("clef");
      c.append(el("sign", "G"), el("line", "2"));
      a.append(c);
    }
    return m;
  };

  // Nouvelle partie de flûte.
  const flute = el("part");
  flute.setAttribute("id", "OMR-FLUTE");
  let last = "";
  for (const num of order) {
    const from = fluteOf.get(systemOf.get(num) ?? 0) ?? "";
    const src = from ? byPart.get(from)?.get(num) : undefined;
    const first = flute.children.length === 0;
    const m = src ? cleanFluteMeasure(src, from, num, from !== last) : restMeasure(num, idOf(parts[0]));
    if (src) last = from;
    if (first) {
      // signature et armure du début (prises dans la première partie)
      const a0 = kids(kids(parts[0], "measure")[0], "attributes")[0];
      const a = kids(m, "attributes")[0];
      for (const tag of ["key", "time"]) {
        const t = a0?.querySelector(`:scope > ${tag}`);
        if (a && t && !a.querySelector(`:scope > ${tag}`)) a.append(t.cloneNode(true));
      }
    }
    flute.append(m);
  }
  // Les autres parties génériques : du piano, sauf là où elles portaient la flûte.
  for (const p of generic) {
    for (const m of kids(p, "measure")) {
      const num = m.getAttribute("number") ?? "";
      if (fluteOf.get(systemOf.get(num) ?? 0) === idOf(p)) p.replaceChild(restMeasure(num, idOf(p)), m);
    }
  }
  const list = root.querySelector(":scope > part-list");
  const sp = el("score-part");
  sp.setAttribute("id", "OMR-FLUTE");
  sp.append(el("part-name", "Flûte"));
  list?.insertBefore(sp, list.firstChild);
  // Une partie à une seule portée, en clé de sol, dans la tessiture de la flûte : la 2ᵉ flûte d'un
  // duo (jouée par l'application, affichée sous votre partie) ; sinon du piano.
  let flutes = 1;
  let pianoCount = 0;
  const noPiano = pianos.size === 0 && Array.from(root.getElementsByTagName("clef")).every((c) => c.querySelector(":scope > sign")?.textContent?.trim() === "G");
  generic.forEach((p) => {
    const declared = list?.querySelector(`:scope > score-part[id="${idOf(p)}"]`);
    // partie vidée (elle ne portait que la flûte) : retirée, ce n'est pas un accompagnement
    if (p.getElementsByTagName("pitch").length === 0) {
      p.remove();
      declared?.remove();
      return;
    }
    const name = declared?.querySelector(":scope > part-name");
    if (name) name.textContent = isFluteLike(p, noPiano) ? `Flûte ${++flutes}` : `Piano (${++pianoCount})`;
  });
  const firstPart = root.querySelector(":scope > part"); // la première a pu être retirée (vide)
  if (firstPart) root.insertBefore(flute, firstPart);
  else root.appendChild(flute);
  return true;
}

export function prepareImport(rawXml: string, fileName: string): PreparedImport {
  let doc = parseMusicXml(rawXml);
  const fromOmr = adoptOmrFlute(doc);
  if (fromOmr) {
    rawXml = new XMLSerializer().serializeToString(doc);
    doc = parseMusicXml(rawXml);
  }
  const movement = movementInfo(doc, fileName);
  let folded = 0;
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
    // Deux flûtes sur la même portée : la voix du haut pour l'élève, l'autre jouée par l'application.
    const secondVoice = splitFluteVoices(doc);
    // Notes impossibles à la flûte (souvent une erreur de reconnaissance) : ramenées à l'octave jouable.
    if (flute) folded = foldToFluteRange(flute);
    if (secondVoice) foldToFluteRange(secondVoice);
    // Gardés pour être joués par l'application : le piano, et la 2ᵉ flûte d'un duo
    // (l'élève joue la 1ʳᵉ flûte, la première partie nommée flûte).
    const otherPianos = pianos.filter((id) => id !== keptId);
    const otherFlutes = otherFluteIds(parseMusicXml(rawXml), keptId);
    const hasFlute2 = otherFlutes.length > 0 || secondVoice !== null;
    partners = [...(otherPianos.length ? ["piano" as const] : []), ...(hasFlute2 ? ["flute" as const] : [])];
    kind = otherPianos.length ? "flute-piano" : "flute";
    if (partners.length) {
      const others = [...otherPianos, ...otherFlutes];
      // Sans autre partie, l'accompagnement part d'une copie vide de la partition (titre, tempo…).
      const acc = others.length ? partsOnly(rawXml, others, tempos) : (doc.cloneNode(true) as Document);
      if (!others.length) keepParts(acc, []);
      if (secondVoice) appendFlute2(acc, secondVoice);
      // la 2ᵉ flûte aussi, jouée par l'application avec un vrai son de flûte
      for (const part of Array.from(acc.documentElement.querySelectorAll(":scope > part"))) {
        if (!otherPianos.includes(part.getAttribute("id") ?? "")) foldToFluteRange(part);
      }
      accompaniment = new XMLSerializer().serializeToString(acc);
    }
  } else if (pianos.length) {
    kind = "piano";
    keepParts(doc, pianos);
    const first = doc.documentElement.querySelector(":scope > part");
    if (first && !hasTempoMarks(first)) copyTempoMarks(tempos, first);
  } else {
    throw new Error("Aucune partie de flûte ni de piano trouvée dans cette partition.");
  }
  const a = analyseScore(doc);
  if (a.title === "Sans titre" && !movement.title) {
    // pas de titre dans le fichier (Audiveris) : celui du nom de fichier, affiché sur la partition
    const root = doc.documentElement;
    const t = doc.createElementNS(root.namespaceURI, "movement-title");
    t.textContent = fileName.replace(/\.(mxl|musicxml|xml|pdf)$/i, "").replace(/\.(mvt|page)\d+/gi, "");
    root.insertBefore(t, root.querySelector(":scope > identification, :scope > defaults, :scope > credit, :scope > part-list"));
  }
  const xml = new XMLSerializer().serializeToString(doc);
  // « Ballade.mvt2.mxl » (plusieurs morceaux reconnus dans un PDF) → « Ballade – 2 »
  const mvt = fileName.match(/\.mvt(\d+)\./i)?.[1];
  const fallbackTitle =
    fileName.replace(/\.(mxl|musicxml|xml|pdf)$/i, "").replace(/\.(mvt|page)\d+/gi, "") + (mvt ? ` – ${mvt}` : "");
  const title = movement.title ?? (a.title === "Sans titre" ? fallbackTitle : a.title);
  const warnings = kind === "piano" ? [] : scoreWarnings(a);
  if (fromOmr) warnings.unshift("partition reconnue automatiquement : des notes ou des rythmes peuvent être faux, relisez-la");
  if (folded > 0) {
    warnings.unshift(
      `${folded} note${folded > 1 ? "s" : ""} hors de la tessiture de la flûte ${folded > 1 ? "ont été ramenées" : "a été ramenée"} à l'octave jouable`,
    );
  }
  return {
    xml,
    accompaniment,
    // une partition pour piano n'est pas suivie au micro : pas d'avertissement de tessiture de flûte
    warnings,
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
      ...(movement.work ? { work: movement.work, movement: movement.movement } : {}),
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
