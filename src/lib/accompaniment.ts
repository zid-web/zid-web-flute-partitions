/**
 * Parties de piano d'une partition MusicXML : repérage, et notes à jouer (pour le vrai piano
 * de `piano.ts`). Pur : aucun son ni affichage, testé.
 */
import { DEFAULT_QPM, partTempoMap } from "./tempo";

const FLUTE = /\b(flute|flûte|flauto|flöte|fl\.)/i;
const PIANO = /piano|pianoforte|klavier|clavier|keyboard|harpsi|cembal|clavecin|continuo|organ|orgue/i;
const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Nuances écrites → force de frappe (0–1). */
const DYNAMICS: Record<string, number> = {
  pppp: 0.2, ppp: 0.27, pp: 0.35, p: 0.47, mp: 0.58, mf: 0.68, f: 0.8, ff: 0.9, fff: 1, ffff: 1,
  sf: 0.85, sfz: 0.88, fp: 0.75, fz: 0.85, rf: 0.8, rfz: 0.85,
};
const DEFAULT_VELOCITY = DYNAMICS.mf;

// --- Ornements ---------------------------------------------------------------

const LETTERS = "CDEFGAB";
const ACCIDENTALS: Record<string, number> = {
  sharp: 1, natural: 0, flat: -1, "double-sharp": 2, "sharp-sharp": 2, "flat-flat": -2,
};
type Ornament = "trill" | "mordent" | "inverted-mordent" | "turn" | "inverted-turn";
const ORNAMENTS: Record<string, Ornament> = {
  "trill-mark": "trill", shake: "trill", mordent: "mordent", "inverted-mordent": "inverted-mordent",
  turn: "turn", "inverted-turn": "inverted-turn", "delayed-turn": "turn",
};

/** Altération d'une note d'après l'armure (`fifths` : + dièses, − bémols). */
function keyAlter(letter: string, fifths: number): number {
  if (fifths > 0) return "FCGDAEB".indexOf(letter) < fifths ? 1 : 0;
  if (fifths < 0) return "BEADGCF".indexOf(letter) < -fifths ? -1 : 0;
  return 0;
}

/** Note voisine (degré du dessus ou du dessous dans la tonalité), en MIDI. */
export function neighbour(step: string, octave: number, dir: 1 | -1, fifths: number, accidental?: number): number {
  let i = LETTERS.indexOf(step) + dir;
  let oct = octave;
  if (i > 6) [i, oct] = [0, oct + 1];
  if (i < 0) [i, oct] = [6, oct - 1];
  const letter = LETTERS[i];
  return (oct + 1) * 12 + STEP[letter] + (accidental ?? keyAlter(letter, fifths));
}

export interface PendingOrnament {
  type: Ornament;
  upper: number;
  lower: number;
}

/**
 * Développe un ornement en notes réelles : trille (note / voisine du dessus, en alternance rapide
 * sur toute la durée), mordant (note, dessous, note), mordant inversé (note, dessus, note),
 * gruppetto (dessus, note, dessous, note) et gruppetto inversé.
 */
export function expandOrnament(n: PianoNote, o: PendingOrnament): PianoNote[] {
  // Notes de l'ornement liées entre elles ; la dernière garde l'articulation de la note écrite.
  const at = (midi: number, start: number, seconds: number, accent = 1): PianoNote => ({
    midi, startSec: n.startSec + start, seconds, velocity: n.velocity * accent, slurred: true,
  });
  const rest = (from: number): PianoNote => ({ ...at(n.midi, from, n.seconds - from), slurred: n.slurred, gate: n.gate });
  if (o.type === "trill" && n.seconds >= 0.25) {
    // ~14 notes par seconde au tempo écrit, en nombre pair : la trille finit sur la note principale.
    let count = Math.max(4, Math.round(n.seconds / 0.07));
    if (count % 2) count++;
    const d = n.seconds / count;
    const notes = Array.from({ length: count }, (_, k) => at(k % 2 ? o.upper : n.midi, k * d, d, k % 2 ? 0.9 : 1));
    notes[count - 1] = { ...notes[count - 1], slurred: n.slurred, gate: n.gate };
    return notes;
  }
  const d = Math.min(0.08, n.seconds / 4);
  switch (o.type) {
    case "mordent":
      return [at(n.midi, 0, d), at(o.lower, d, d, 0.9), rest(2 * d)];
    case "turn":
      return [at(o.upper, 0, d), at(n.midi, d, d), at(o.lower, 2 * d, d, 0.9), rest(3 * d)];
    case "inverted-turn":
      return [at(o.lower, 0, d), at(n.midi, d, d), at(o.upper, 2 * d, d, 0.9), rest(3 * d)];
    default: // mordent inversé, et trille trop courte pour plus de trois notes
      return [at(n.midi, 0, d), at(o.upper, d, d, 0.9), rest(2 * d)];
  }
}

export type ScoreKind = "flute" | "flute-piano" | "piano";

const children = (el: Element, name: string) => Array.from(el.children).filter((c) => c.localName === name);
const child = (el: Element, name: string) => children(el, name)[0];
const text = (el: Element | undefined, name: string) => (el ? child(el, name)?.textContent?.trim() : undefined);

function partNames(root: Element): Map<string, string> {
  const names = new Map<string, string>();
  for (const sp of Array.from(root.getElementsByTagName("score-part"))) {
    const instrument = sp.getElementsByTagName("instrument-name")[0]?.textContent ?? "";
    names.set(sp.getAttribute("id") ?? "", `${text(sp, "part-name") ?? ""} ${instrument}`);
  }
  return names;
}

/** Une partie de piano : nom d'instrument à clavier, ou écrite sur deux portées (et pas une flûte). */
export function isPianoPart(part: Element, name: string): boolean {
  if (FLUTE.test(name)) return false;
  if (PIANO.test(name)) return true;
  return Array.from(part.getElementsByTagName("staves")).some((s) => Number(s.textContent) >= 2);
}

/** Identifiants des parties de piano d'un document MusicXML. */
export function pianoPartIds(doc: Document): string[] {
  const root = doc.documentElement;
  const names = partNames(root);
  return children(root, "part")
    .filter((p) => isPianoPart(p, names.get(p.getAttribute("id") ?? "") ?? ""))
    .map((p) => p.getAttribute("id") ?? "");
}

/** Autres parties de flûte que celle gardée pour l'élève (2ᵉ flûte d'un duo, jouée par l'application). */
export function otherFluteIds(doc: Document, keptId: string): string[] {
  const names = partNames(doc.documentElement);
  return children(doc.documentElement, "part")
    .map((p) => p.getAttribute("id") ?? "")
    .filter((id) => id !== keptId && FLUTE.test(names.get(id) ?? ""));
}

/** Instruments joués par l'application avec l'élève. */
export type Partner = "piano" | "flute";

/**
 * Répartit un fichier d'accompagnement : parties de piano (nom à clavier ou deux portées) et
 * autres flûtes (nommées flûte, ou à une seule portée : 2ᵉ flûte d'un duo reconnu par OMR).
 */
export function splitAccompaniment(xml: string): { piano: PianoNote[]; flute: PianoNote[] } {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const names = partNames(doc.documentElement);
  const pianoIds: string[] = [];
  const fluteIds: string[] = [];
  for (const part of children(doc.documentElement, "part")) {
    const id = part.getAttribute("id") ?? "";
    (isPianoPart(part, names.get(id) ?? "") ? pianoIds : fluteIds).push(id);
  }
  return {
    piano: pianoIds.length ? pianoNotes(xml, pianoIds) : [],
    flute: fluteIds.length ? pianoNotes(xml, fluteIds) : [],
  };
}

/** Partenaires d'une partition : champ `partners`, ou ancien `kind: "flute-piano"`. */
export function partnersOf(entry: { partners?: Partner[]; kind?: string }): Partner[] {
  return entry.partners ?? (entry.kind === "flute-piano" ? ["piano"] : []);
}

// --- Deux voix sur une même portée de flûte -----------------------------------

const voiceOf = (note: Element) => text(note, "voice") ?? "1";

/** Longueur d'une mesure dans ses propres unités (divisions) : la plus longue de ses voix. */
function rawMeasureLength(measure: Element): number {
  let pos = 0;
  let length = 0;
  for (const el of Array.from(measure.children)) {
    const d = Number(text(el, "duration") ?? 0);
    if (el.localName === "backup") pos -= d;
    else if (el.localName === "forward" || (el.localName === "note" && !child(el, "chord") && !child(el, "grace") && !child(el, "cue"))) {
      pos += d;
      length = Math.max(length, pos);
    }
  }
  return length;
}

/**
 * Ne garde qu'une voix dans une partie : retire les notes des autres voix et les retours en arrière
 * (`<backup>`) ; une mesure devenue plus courte est complétée par un silence, pour que la partie
 * garde exactement la même durée (le son et le curseur restent ensemble).
 */
function keepVoice(part: Element, voice: string): void {
  for (const measure of children(part, "measure")) {
    const before = rawMeasureLength(measure);
    for (const el of Array.from(measure.children)) {
      const other =
        (el.localName === "note" && voiceOf(el) !== voice) ||
        el.localName === "backup" ||
        (el.localName === "forward" && text(el, "voice") !== undefined && text(el, "voice") !== voice);
      if (other) el.remove();
    }
    const missing = before - rawMeasureLength(measure);
    if (missing > 0) {
      const doc = part.ownerDocument;
      const ns = measure.namespaceURI;
      const restNote = doc.createElementNS(ns, "note");
      restNote.appendChild(doc.createElementNS(ns, "rest"));
      const duration = doc.createElementNS(ns, "duration");
      duration.textContent = String(missing);
      const v = doc.createElementNS(ns, "voice");
      v.textContent = voice;
      restNote.append(duration, v);
      measure.appendChild(restNote);
    }
  }
}

/**
 * Deux flûtes écrites sur une même portée (deux voix) : la voix la plus aiguë reste pour l'élève,
 * l'autre est renvoyée comme une partie « Flûte 2 », jouée par l'application. Une voix qui ne
 * contient que des silences est simplement retirée. Modifie `doc` (une seule partie, la flûte).
 */
export function splitFluteVoices(doc: Document): Element | null {
  const part = children(doc.documentElement, "part")[0];
  if (!part) return null;
  const pitches = new Map<string, number[]>();
  const seen = new Set<string>();
  for (const note of Array.from(part.getElementsByTagName("note"))) {
    seen.add(voiceOf(note));
    const pitch = child(note, "pitch");
    if (!pitch || child(note, "grace")) continue;
    const step = text(pitch, "step") ?? "";
    if (!(step in STEP)) continue;
    const midi = (Number(text(pitch, "octave")) + 1) * 12 + STEP[step] + Math.round(Number(text(pitch, "alter") ?? 0));
    pitches.set(voiceOf(note), [...(pitches.get(voiceOf(note)) ?? []), midi]);
  }
  const mean = (v: string) => (pitches.get(v) ?? []).reduce((a, b) => a + b, 0) / (pitches.get(v)?.length || 1);
  const voices = [...pitches.keys()].sort((a, b) => mean(b) - mean(a));
  const top = voices[0] ?? "1";
  if (voices.length < 2) {
    if (seen.size > 1) keepVoice(part, top); // voix de silences seulement : retirée
    return null;
  }
  const second = part.cloneNode(true) as Element;
  const id = `${part.getAttribute("id") ?? "P1"}-flute2`;
  second.setAttribute("id", id);
  keepVoice(part, top);
  keepVoice(second, voices[1]);
  return second;
}

/** Ajoute une partie « Flûte 2 » à un document (déclaration dans part-list comprise). */
export function appendFlute2(doc: Document, part: Element): void {
  const root = doc.documentElement;
  const ns = root.namespaceURI;
  let list = child(root, "part-list");
  if (!list) {
    list = doc.createElementNS(ns, "part-list");
    root.insertBefore(list, children(root, "part")[0] ?? null);
  }
  const sp = doc.createElementNS(ns, "score-part");
  sp.setAttribute("id", part.getAttribute("id") ?? "P-flute2");
  const name = doc.createElementNS(ns, "part-name");
  name.textContent = "Flûte 2";
  sp.appendChild(name);
  list.appendChild(sp);
  root.appendChild(doc.importNode(part, true));
}

/** Y a-t-il une partie nommée flûte ? */
export function hasFlutePart(doc: Document): boolean {
  return [...partNames(doc.documentElement).values()].some((name) => FLUTE.test(name));
}

/** Ne garde que les parties demandées (et leur déclaration dans part-list). */
export function keepParts(doc: Document, ids: string[]): void {
  const root = doc.documentElement;
  for (const p of children(root, "part")) if (!ids.includes(p.getAttribute("id") ?? "")) p.remove();
  const list = child(root, "part-list");
  for (const el of Array.from(list?.children ?? [])) {
    if ((el.localName === "score-part" && !ids.includes(el.getAttribute("id") ?? "")) || el.localName === "part-group") el.remove();
  }
}

export interface PianoNote {
  midi: number;
  /** Début et durée écrite en secondes au tempo écrit. */
  startSec: number;
  seconds: number;
  /** Force 0–1 : nuances (pp → ff), soufflets, accents. */
  velocity: number;
  /** Part de la durée écrite réellement jouée (staccato 0,5…) ; absent = jeu habituel de l'instrument. */
  gate?: number;
  /** Liée à la note suivante (liaison d'expression) : sans nouveau coup de langue. */
  slurred?: boolean;
  /** Note d'un accord (pas la première) : la mélodie ne la compte pas. */
  chord?: boolean;
}

/** Articulations écrites → durée jouée et accent. */
const ARTICULATIONS: Record<string, { gate?: number; accent?: number }> = {
  staccato: { gate: 0.5 },
  staccatissimo: { gate: 0.3 },
  spiccato: { gate: 0.35 },
  "detached-legato": { gate: 0.75 }, // louré
  tenuto: { gate: 1, accent: 1.05 },
  accent: { accent: 1.25 },
  "strong-accent": { accent: 1.4 }, // marcato
  "breath-mark": { gate: 0.82 }, // respiration après la note
  caesura: { gate: 0.7 },
};
/** Soufflet sans nuance d'arrivée écrite : variation de force par défaut. */
const WEDGE_STEP = 0.18;

export interface MeasureTimeline {
  /** Début de chaque mesure, en secondes au tempo écrit. */
  startSec: number[];
  /** Durée d'une noire dans chaque mesure. */
  secPerQuarter: number[];
}

/**
 * Calendrier des mesures, partagé par le son et le curseur : la durée d'une mesure est la plus
 * longue de ses parties (voix et portées comprises), au tempo de la mesure. Le son (piano, flûtes)
 * et le curseur placent leurs notes à partir des mêmes débuts de mesure : ils ne peuvent pas dériver.
 */
export function measureTimeline(xmlOrDoc: string | Document): MeasureTimeline {
  const doc = typeof xmlOrDoc === "string" ? new DOMParser().parseFromString(xmlOrDoc, "application/xml") : xmlOrDoc;
  const parts = children(doc.documentElement, "part");
  const tempos = parts[0] ? partTempoMap(parts[0]) : [];
  const lengths: number[] = [];
  for (const part of parts) {
    let divisions = 1;
    children(part, "measure").forEach((measure, m) => {
      let pos = 0;
      let length = 0;
      for (const el of Array.from(measure.children)) {
        if (el.localName === "attributes") divisions = Number(text(el, "divisions")) || divisions;
        else if (el.localName === "backup") pos -= Number(text(el, "duration") ?? 0) / divisions;
        else if (el.localName === "forward") {
          pos += Number(text(el, "duration") ?? 0) / divisions;
          length = Math.max(length, pos);
        } else if (el.localName === "note" && !child(el, "chord") && !child(el, "grace") && !child(el, "cue")) {
          pos += Number(text(el, "duration") ?? 0) / divisions;
          length = Math.max(length, pos);
        }
      }
      lengths[m] = Math.max(lengths[m] ?? 0, length);
    });
  }
  const startSec: number[] = [];
  const secPerQuarter: number[] = [];
  let t = 0;
  lengths.forEach((quarters, m) => {
    const spq = 60 / (tempos[m] ?? tempos[tempos.length - 1] ?? DEFAULT_QPM);
    startSec.push(t);
    secPerQuarter.push(spq);
    t += quarters * spq;
  });
  return { startSec, secPerQuarter };
}

/**
 * Toutes les notes des parties demandées, dans l'ordre, avec leur interprétation : nuances
 * (et soufflets), articulations, liaisons, ornements. Accords, voix multiples (backup/forward),
 * notes liées réunies, appoggiatures ignorées. Le temps suit la carte des tempos (même calcul
 * que la flûte dans `score.ts`), pour que toutes les voix restent ensemble.
 */
function readNotes(xml: string, partIds?: string[]): { notes: PianoNote[]; ornaments: Map<PianoNote, PendingOrnament> } {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  const parts = children(root, "part").filter((p) => !partIds || partIds.includes(p.getAttribute("id") ?? ""));
  const timeline = measureTimeline(doc);
  const notes: PianoNote[] = [];
  const ornaments = new Map<PianoNote, PendingOrnament>();

  for (const part of parts) {
    let divisions = 1;
    let fifths = 0;
    let velocity = DEFAULT_VELOCITY;
    let openSlurs = 0;
    // Soufflet en cours : notes concernées et force de départ.
    // `stopped` : fin du soufflet écrite ; la nuance d'arrivée, souvent écrite juste après, le termine.
    let wedge: { dir: 1 | -1; from: number; notes: PianoNote[]; stopped?: boolean } | null = null;
    // note liée en attente de sa suite : clé « hauteur » → note déjà émise
    const tied = new Map<number, PianoNote>();
    const endWedge = (target?: number) => {
      if (!wedge) return;
      const to = Math.max(0.15, Math.min(1, target ?? wedge.from + wedge.dir * WEDGE_STEP));
      const w = wedge;
      w.notes.forEach((n, i) => {
        const ratio = n.velocity / w.from; // garde les accents
        n.velocity = Math.min(1, (w.from + ((to - w.from) * (i + 1)) / w.notes.length) * ratio);
      });
      velocity = to;
      wedge = null;
    };
    children(part, "measure").forEach((measure, m) => {
      const secPerQuarter = timeline.secPerQuarter[m];
      const measureStartSec = timeline.startSec[m];
      let pos = 0; // en noires depuis le début de la mesure
      let lastStart = 0;
      for (const el of Array.from(measure.children)) {
        if (el.localName === "attributes") {
          divisions = Number(text(el, "divisions")) || divisions;
          const key = child(el, "key");
          if (key && text(key, "fifths") !== undefined) fifths = Number(text(key, "fifths")) || 0;
        } else if (el.localName === "direction") {
          const dyn = el.getElementsByTagName("dynamics")[0];
          const mark = dyn?.firstElementChild?.localName;
          let level: number | undefined = mark !== undefined ? DYNAMICS[mark] : undefined;
          const sound = el.getElementsByTagName("sound")[0]?.getAttribute("dynamics");
          if (level === undefined && sound && Number(sound) > 0) level = Math.min(1, (Number(sound) / 100) * 0.8);
          const w = el.getElementsByTagName("wedge")[0]?.getAttribute("type");
          if (level !== undefined) {
            // une nuance écrite après un soufflet en est l'arrivée
            if (wedge) endWedge(level);
            velocity = level;
          }
          if (w === "stop" && wedge) wedge.stopped = true;
          else if (w === "crescendo" || w === "diminuendo") {
            endWedge();
            wedge = { dir: w === "crescendo" ? 1 : -1, from: velocity, notes: [] };
          }
        } else if (el.localName === "backup") {
          pos -= Number(text(el, "duration") ?? 0) / divisions;
        } else if (el.localName === "forward") {
          pos += Number(text(el, "duration") ?? 0) / divisions;
        } else if (el.localName === "note") {
          if (child(el, "grace") || child(el, "cue")) continue;
          if (wedge?.stopped) endWedge(); // soufflet fini sans nuance d'arrivée écrite
          const quarters = Number(text(el, "duration") ?? 0) / divisions;
          const isChord = Boolean(child(el, "chord"));
          const start = isChord ? lastStart : pos;
          if (!isChord) {
            lastStart = pos;
            pos += quarters;
          }
          const pitch = child(el, "pitch");
          if (child(el, "rest") || !pitch) continue;
          const step = text(pitch, "step") ?? "";
          if (!(step in STEP)) continue;
          const midi = (Number(text(pitch, "octave")) + 1) * 12 + STEP[step] + Math.round(Number(text(pitch, "alter") ?? 0));
          const ties = children(el, "tie").map((t) => t.getAttribute("type"));
          const seconds = quarters * secPerQuarter;
          // liaisons d'expression : ouvertes et fermées sur cette note
          for (const slur of Array.from(el.getElementsByTagName("slur"))) {
            if (slur.getAttribute("type") === "start") openSlurs++;
            else if (slur.getAttribute("type") === "stop") openSlurs = Math.max(0, openSlurs - 1);
          }
          const previous = tied.get(midi);
          if (ties.includes("stop") && previous) {
            previous.seconds += seconds; // suite d'une note liée : on prolonge, sans refrapper
            previous.slurred = openSlurs > 0;
            if (!ties.includes("start")) tied.delete(midi);
            continue;
          }
          let gate: number | undefined;
          let accent = 1;
          for (const art of Array.from(el.getElementsByTagName("articulations")[0]?.children ?? [])) {
            const a = ARTICULATIONS[art.localName];
            if (a?.gate !== undefined) gate = Math.min(gate ?? 1, a.gate);
            if (a?.accent) accent = Math.max(accent, a.accent);
          }
          const note: PianoNote = {
            midi,
            startSec: measureStartSec + start * secPerQuarter,
            seconds,
            velocity: Math.min(1, velocity * accent),
            slurred: openSlurs > 0,
            ...(gate !== undefined ? { gate } : {}),
            ...(isChord ? { chord: true } : {}),
          };
          notes.push(note);
          wedge?.notes.push(note);
          const ornament = readOrnament(el, step, Number(text(pitch, "octave")), fifths);
          if (ornament) ornaments.set(note, ornament);
          if (ties.includes("start")) tied.set(midi, note);
        }
      }
    });
    endWedge(); // soufflet resté ouvert en fin de partie
  }
  return { notes, ornaments };
}

/** Notes à jouer des parties demandées (piano, 2ᵉ flûte), ornements développés. */
export function pianoNotes(xml: string, partIds?: string[]): PianoNote[] {
  const { notes, ornaments } = readNotes(xml, partIds);
  // Les ornements sont développés une fois les notes liées réunies (une trille dure toute la note).
  return notes
    .flatMap((n) => (ornaments.has(n) ? expandOrnament(n, ornaments.get(n)!) : [n]))
    .sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
}

/** Note de la mélodie avec son interprétation, une par note attaquée, dans l'ordre du curseur. */
export interface MelodyNote {
  velocity: number;
  gate?: number;
  slurred: boolean;
  ornament: PendingOrnament | null;
}

/**
 * Interprétation de la mélodie (première partie) : une entrée par note attaquée (ni silence, ni
 * appoggiature, ni suite de note liée, ni note d'accord), dans l'ordre — celui des notes du curseur.
 */
export function melodyNotes(xml: string): MelodyNote[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const first = children(doc.documentElement, "part")[0]?.getAttribute("id");
  if (!first) return [];
  const { notes, ornaments } = readNotes(xml, [first]);
  return notes
    .filter((n) => !n.chord)
    .sort((a, b) => a.startSec - b.startSec)
    .map((n) => ({ velocity: n.velocity, gate: n.gate, slurred: Boolean(n.slurred), ornament: ornaments.get(n) ?? null }));
}

/** Ornement écrit sur une note (`<notations><ornaments>`), avec l'altération éventuelle de la voisine. */
function readOrnament(note: Element, step: string, octave: number, fifths: number): PendingOrnament | null {
  const box = note.getElementsByTagName("ornaments")[0];
  if (!box) return null;
  const type = Array.from(box.children).map((c) => ORNAMENTS[c.localName]).find(Boolean);
  if (!type) return null;
  let above: number | undefined;
  let below: number | undefined;
  for (const mark of Array.from(box.children).filter((c) => c.localName === "accidental-mark")) {
    const value = ACCIDENTALS[mark.textContent?.trim() ?? ""];
    if (value === undefined) continue;
    if (mark.getAttribute("placement") === "below" && type !== "trill") below = value;
    else above = value;
  }
  return {
    type,
    upper: neighbour(step, octave, 1, fifths, above),
    lower: neighbour(step, octave, -1, fifths, below),
  };
}
