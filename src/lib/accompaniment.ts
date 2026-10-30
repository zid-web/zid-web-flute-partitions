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
  /** Début et durée en secondes au tempo écrit. */
  startSec: number;
  seconds: number;
  /** Force de frappe 0–1 (d'après les nuances). */
  velocity: number;
}

/**
 * Toutes les notes des parties de piano, dans l'ordre : accords, voix multiples (backup/forward),
 * notes liées réunies, appoggiatures ignorées. Le temps suit la carte des tempos (même calcul que
 * la flûte dans `score.ts`), pour que piano et flûte restent ensemble.
 */
export function pianoNotes(xml: string, partIds?: string[]): PianoNote[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  const parts = children(root, "part").filter((p) => !partIds || partIds.includes(p.getAttribute("id") ?? ""));
  const firstPart = children(root, "part")[0];
  const tempos = firstPart ? partTempoMap(firstPart) : [];
  const notes: PianoNote[] = [];

  for (const part of parts) {
    let divisions = 1;
    let velocity = DEFAULT_VELOCITY;
    let measureStartSec = 0;
    // note liée en attente de sa suite : clé « hauteur » → note déjà émise
    const tied = new Map<number, PianoNote>();
    children(part, "measure").forEach((measure, m) => {
      const secPerQuarter = 60 / (tempos[m] ?? tempos[tempos.length - 1] ?? DEFAULT_QPM);
      let pos = 0; // en noires depuis le début de la mesure
      let lastStart = 0;
      let length = 0;
      for (const el of Array.from(measure.children)) {
        if (el.localName === "attributes") {
          divisions = Number(text(el, "divisions")) || divisions;
        } else if (el.localName === "direction") {
          const dyn = el.getElementsByTagName("dynamics")[0];
          const mark = dyn?.firstElementChild?.localName;
          if (mark && DYNAMICS[mark] !== undefined) velocity = DYNAMICS[mark];
          const sound = el.getElementsByTagName("sound")[0]?.getAttribute("dynamics");
          if (sound && Number(sound) > 0) velocity = Math.min(1, Number(sound) / 100 * 0.8);
        } else if (el.localName === "backup") {
          pos -= Number(text(el, "duration") ?? 0) / divisions;
        } else if (el.localName === "forward") {
          pos += Number(text(el, "duration") ?? 0) / divisions;
          length = Math.max(length, pos);
        } else if (el.localName === "note") {
          if (child(el, "grace") || child(el, "cue")) continue;
          const quarters = Number(text(el, "duration") ?? 0) / divisions;
          const isChord = Boolean(child(el, "chord"));
          const start = isChord ? lastStart : pos;
          if (!isChord) {
            lastStart = pos;
            pos += quarters;
            length = Math.max(length, pos);
          }
          const pitch = child(el, "pitch");
          if (child(el, "rest") || !pitch) continue;
          const step = text(pitch, "step") ?? "";
          if (!(step in STEP)) continue;
          const midi = (Number(text(pitch, "octave")) + 1) * 12 + STEP[step] + Math.round(Number(text(pitch, "alter") ?? 0));
          const ties = children(el, "tie").map((t) => t.getAttribute("type"));
          const seconds = quarters * secPerQuarter;
          const previous = tied.get(midi);
          if (ties.includes("stop") && previous) {
            previous.seconds += seconds; // suite d'une note liée : on prolonge, sans refrapper
            if (!ties.includes("start")) tied.delete(midi);
            continue;
          }
          const note = { midi, startSec: measureStartSec + start * secPerQuarter, seconds, velocity };
          notes.push(note);
          if (ties.includes("start")) tied.set(midi, note);
        }
      }
      measureStartSec += length * secPerQuarter;
    });
  }
  return notes.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
}
