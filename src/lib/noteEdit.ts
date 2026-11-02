/**
 * Correction d'une note dans l'application (logique pure, testée) : après un import PDF, la
 * reconnaissance automatique se trompe parfois d'une ligne ou d'une altération. On touche la note
 * fausse, on la monte ou la descend (d'un demi-ton ou d'une octave) ou on la remplace par un silence,
 * sans repasser par MuseScore.
 *
 * Les notes sont celles que l'élève joue (première partie), repérées comme le lecteur les connaît
 * (`ScoreStep` : mesure, position, hauteur). Une note liée change avec la note qui l'attaque.
 */

export type NoteEdit = { kind: "semitone"; by: 1 | -1 } | { kind: "octave"; by: 1 | -1 } | { kind: "rest" };

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Orthographe d'une hauteur (0–11) : dièse en montant, bémol en descendant. */
const NATURAL: Record<number, string> = { 0: "C", 2: "D", 4: "E", 5: "F", 7: "G", 9: "A", 11: "B" };
const SHARP: Record<number, string> = { 1: "C", 3: "D", 6: "F", 8: "G", 10: "A" };
const FLAT: Record<number, string> = { 1: "D", 3: "E", 6: "G", 8: "A", 10: "B" };

const kids = (el: Element, name: string) => Array.from(el.children).filter((c) => c.localName === name);
const kid = (el: Element, name: string) => kids(el, name)[0] ?? null;
const num = (el: Element | null, fallback = 0) => {
  const v = Number(el?.textContent?.trim());
  return Number.isFinite(v) && el ? v : fallback;
};

/** Hauteur MIDI d'une note MusicXML (null pour un silence ou une note sans hauteur). */
export function midiOf(note: Element): number | null {
  const pitch = kid(note, "pitch");
  const step = pitch && kid(pitch, "step")?.textContent?.trim();
  if (!pitch || !step || !(step in STEP)) return null;
  return (num(kid(pitch, "octave"), 4) + 1) * 12 + STEP[step] + Math.round(num(kid(pitch, "alter")));
}

const tieTypes = (note: Element) => kids(note, "tie").map((t) => t.getAttribute("type"));
const isTieStop = (note: Element) => tieTypes(note).includes("stop");
const isTieStart = (note: Element) => tieTypes(note).includes("start");

interface Timed {
  note: Element;
  /** Mesure, puis position dans la mesure (en noires). */
  measure: number;
  pos: number;
  midi: number;
}

/** Notes avec hauteur de la première partie, dans l'ordre du temps (notes d'ornement exclues). */
function timedNotes(doc: Document): Timed[] {
  const part = doc.documentElement ? kid(doc.documentElement, "part") : null;
  if (!part) return [];
  const out: Timed[] = [];
  let divisions = 1;
  kids(part, "measure").forEach((measure, m) => {
    let pos = 0;
    let lastStart = 0;
    for (const el of Array.from(measure.children)) {
      if (el.localName === "attributes") divisions = num(kid(el, "divisions"), divisions) || divisions;
      else if (el.localName === "backup") pos -= num(kid(el, "duration")) / divisions;
      else if (el.localName === "forward") pos += num(kid(el, "duration")) / divisions;
      else if (el.localName === "note") {
        if (kid(el, "grace") || kid(el, "cue")) continue;
        const chord = kid(el, "chord") !== null;
        const start = chord ? lastStart : pos;
        if (!chord) {
          lastStart = pos;
          pos += num(kid(el, "duration")) / divisions;
        }
        const midi = midiOf(el);
        if (midi !== null) out.push({ note: el, measure: m, pos: start, midi });
      }
    }
  });
  // tri stable : par mesure, puis par position (plusieurs voix)
  return out
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.measure - b.t.measure || a.t.pos - b.t.pos || a.i - b.i)
    .map(({ t }) => t);
}

function parse(xml: string): Document | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return doc.getElementsByTagName("parsererror").length ? null : doc;
}

/**
 * Note touchée, telle que le lecteur la connaît (`ScoreStep`) : mesure, position dans la mesure
 * (en noires) et hauteur. Elle est retrouvée dans le fichier par ces trois indices, sans compter
 * les notes : une liaison mal écrite (reconnaissance automatique) ne décale rien.
 */
export interface NoteRef {
  measure: number;
  beatInMeasure: number;
  midi: number;
}

function locate(timed: Timed[], ref: NoteRef): Timed | undefined {
  return timed.find((t) => t.measure === ref.measure && Math.abs(t.pos - ref.beatInMeasure) < 1e-3 && t.midi === ref.midi);
}

/** La note est-elle retrouvée dans le fichier (sinon, la correction n'est pas proposée) ? */
export function canEditNote(xml: string, ref: NoteRef): boolean {
  const doc = parse(xml);
  return !!doc && locate(timedNotes(doc), ref) !== undefined;
}

function setPitch(note: Element, midi: number, direction: 1 | -1): void {
  const pitch = kid(note, "pitch");
  if (!pitch) return;
  const doc = note.ownerDocument;
  const pc = ((midi % 12) + 12) % 12;
  const [step, alter] =
    pc in NATURAL ? [NATURAL[pc], 0] : direction > 0 ? [SHARP[pc], 1] : [FLAT[pc], -1];
  const octave = Math.floor((midi - STEP[step] - alter) / 12) - 1;
  while (pitch.firstChild) pitch.removeChild(pitch.firstChild);
  const add = (name: string, value: string) => {
    const el = doc.createElementNS(pitch.namespaceURI, name);
    el.textContent = value;
    pitch.appendChild(el);
  };
  add("step", step);
  if (alter) add("alter", String(alter));
  add("octave", String(octave));
  // l'altération affichée et la hampe forcée se recalculent avec la nouvelle hauteur
  for (const name of ["accidental", "stem"]) for (const el of kids(note, name)) el.remove();
  note.removeAttribute("default-y");
}

function toRest(note: Element): void {
  const doc = note.ownerDocument;
  const chordFollowers: Element[] = [];
  for (let s = note.nextElementSibling; s && s.localName === "note" && kid(s, "chord"); s = s.nextElementSibling) {
    chordFollowers.push(s);
  }
  if (kid(note, "chord")) {
    note.remove(); // une note d'accord disparaît, les autres restent
    return;
  }
  if (chordFollowers.length) {
    kid(chordFollowers[0], "chord")?.remove(); // la note suivante de l'accord prend sa place
    note.remove();
    return;
  }
  const pitch = kid(note, "pitch");
  const rest = doc.createElementNS(note.namespaceURI, "rest");
  if (pitch) note.replaceChild(rest, pitch);
  for (const name of ["tie", "accidental", "stem", "beam", "notehead", "notations", "lyric"]) {
    for (const el of kids(note, name)) el.remove();
  }
  note.removeAttribute("default-y");
}

/**
 * Applique la correction à la note `ref` ; renvoie la partition modifiée et
 * la nouvelle hauteur (null pour un silence), ou null si la note n'existe pas ou sortirait du
 * clavier.
 */
export function applyNoteEdit(xml: string, ref: NoteRef, edit: NoteEdit): { xml: string; midi: number | null } | null {
  const doc = parse(xml);
  if (!doc) return null;
  const timed = timedNotes(doc);
  const target = locate(timed, ref);
  if (!target) return null;
  // la note et les notes qui lui sont liées (même hauteur, à la suite)
  const chain = [target];
  for (let cur = target; isTieStart(cur.note); ) {
    const at = timed.indexOf(cur);
    const next = timed.slice(at + 1).find((t) => t.midi === target.midi && isTieStop(t.note));
    if (!next) break;
    chain.push(next);
    cur = next;
  }
  let midi: number | null;
  if (edit.kind === "rest") {
    midi = null;
    chain.forEach((t) => toRest(t.note));
  } else {
    midi = target.midi + (edit.kind === "octave" ? 12 * edit.by : edit.by);
    if (midi < 21 || midi > 108) return null;
    for (const t of chain) {
      if (edit.kind === "octave") {
        // même nom de note, une octave plus haut ou plus bas
        const octave = kid(kid(t.note, "pitch")!, "octave");
        if (octave) octave.textContent = String(num(octave, 4) + edit.by);
        for (const el of kids(t.note, "stem")) el.remove();
        t.note.removeAttribute("default-y");
      } else setPitch(t.note, midi, edit.by);
    }
  }
  return { xml: new XMLSerializer().serializeToString(doc), midi };
}
