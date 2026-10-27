/**
 * Analyse de difficulté d'une partition de flûte, dans le navigateur.
 * Portage fidèle de `.claude/skills/imslp-flute-curator/scripts/difficulty.py` :
 * mêmes indicateurs, mêmes poids, mêmes seuils (un test vérifie l'accord avec catalog.json).
 */
import { midiToName } from "./notes";

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR_KEYS: Record<number, string> = {
  [-7]: "Do♭", [-6]: "Sol♭", [-5]: "Ré♭", [-4]: "La♭", [-3]: "Mi♭", [-2]: "Si♭", [-1]: "Fa",
  0: "Do", 1: "Sol", 2: "Ré", 3: "La", 4: "Mi", 5: "Si", 6: "Fa♯", 7: "Do♯",
};
/** Notes délicates sur la flûte (passages de registre, 3ᵉ octave). */
const AWKWARD = new Set([61, 63, 74, 75, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96]);
const FLUTE = /\b(flute|flûte|flauto|flöte|fl\.)/i;

export interface ScoreAnalysis {
  title: string;
  composer: string;
  noteCount: number;
  lowMidi: number;
  highMidi: number;
  low: string;
  high: string;
  rangeSemitones: number;
  thirdOctaveRatio: number;
  key: string;
  fifths: number;
  time: string;
  tempo: number;
  accidentalRatio: number;
  shortestBeats: number;
  notesPerSecond: number;
  rhythmVariety: number;
  maxLeap: number;
  largeLeapRatio: number;
  awkwardRatio: number;
  tuplets: number;
  ornaments: number;
  multiVoice: boolean;
  complexity: number;
  level: 1 | 2 | 3 | 4 | 5;
}

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const child = (el: Element, selector: string) => el.querySelector(`:scope > ${selector}`);
const text = (el: Element | null, selector: string) => el?.querySelector(`:scope > ${selector}`)?.textContent?.trim() ?? null;

export function parseMusicXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("Fichier MusicXML illisible.");
  if (doc.documentElement.localName === "score-timewise") {
    throw new Error("Format « score-timewise » non pris en charge : réexportez en MusicXML standard.");
  }
  if (doc.documentElement.localName !== "score-partwise") throw new Error("Ce fichier n'est pas une partition MusicXML.");
  return doc;
}

/** Ne garde que la partie de flûte (ou la seule partie). Renvoie false si aucune flûte. */
export function extractFlutePart(doc: Document): boolean {
  const root = doc.documentElement;
  const parts = Array.from(root.querySelectorAll(":scope > part"));
  const names = new Map<string, string>();
  for (const sp of Array.from(root.querySelectorAll("score-part"))) {
    names.set(sp.getAttribute("id") ?? "", `${text(sp, "part-name") ?? ""} ${sp.querySelector("instrument-name")?.textContent ?? ""}`);
  }
  let keep = Array.from(names).find(([, n]) => FLUTE.test(n))?.[0];
  if (!keep && parts.length === 1) keep = parts[0].getAttribute("id") ?? undefined;
  if (!keep) return false;
  for (const p of parts) if (p.getAttribute("id") !== keep) p.remove();
  const partList = child(root, "part-list");
  for (const el of Array.from(partList?.children ?? [])) {
    if ((el.localName === "score-part" && el.getAttribute("id") !== keep) || el.localName === "part-group") el.remove();
  }
  return true;
}

export function analyseScore(doc: Document): ScoreAnalysis {
  const root = doc.documentElement;
  const title = (text(root, "work > work-title") || text(root, "movement-title") || "Sans titre").trim();
  const composer =
    Array.from(root.querySelectorAll("creator")).find((c) => c.getAttribute("type") === "composer" && c.textContent?.trim())
      ?.textContent?.trim() ?? "Inconnu";
  const part = child(root, "part");
  if (!part) throw new Error("Aucune partie dans la partition.");

  let divisions = 1;
  let fifths = 0;
  let time = "4/4";
  let tempo = 0;
  const pitches: number[] = [];
  const durations: number[] = [];
  let accidentals = 0;
  let tuplets = 0;
  let ornaments = 0;
  const voices = new Set<string>();
  const measures = Array.from(part.querySelectorAll(":scope > measure"));
  let totalBeats = 0;

  for (const measure of measures) {
    const attrs = child(measure, "attributes");
    if (attrs) {
      divisions = Number(text(attrs, "divisions") ?? divisions) || divisions;
      const f = attrs.querySelector(":scope > key > fifths");
      if (f) fifths = Number(f.textContent);
      const beats = attrs.querySelector(":scope > time > beats");
      if (beats) time = `${beats.textContent}/${attrs.querySelector(":scope > time > beat-type")?.textContent}`;
    }
    for (const snd of Array.from(measure.getElementsByTagName("sound"))) {
      if (snd.getAttribute("tempo") && !tempo) tempo = Number(snd.getAttribute("tempo"));
    }
    for (const pm of Array.from(measure.getElementsByTagName("per-minute"))) {
      const v = pm.textContent?.trim() ?? "";
      if (!tempo && /^\d+(\.\d+)?$/.test(v)) tempo = Number(v);
    }
    let measureBeats = 0;
    for (const note of Array.from(measure.querySelectorAll(":scope > note"))) {
      voices.add(text(note, "voice") ?? "1");
      if (child(note, "grace") || child(note, "cue")) continue;
      const dur = Number(text(note, "duration") ?? 0) / divisions;
      const isChord = Boolean(child(note, "chord"));
      if (!isChord) measureBeats += dur;
      if (child(note, "time-modification")) tuplets++;
      if (note.querySelector(":scope > notations > ornaments, :scope > notations > articulations > staccato")) ornaments++;
      if (child(note, "rest") || isChord) continue;
      if (Array.from(note.querySelectorAll(":scope > tie")).some((t) => t.getAttribute("type") === "stop")) {
        if (durations.length) durations[durations.length - 1] += dur;
        continue;
      }
      const step = text(note, "pitch > step");
      const octave = text(note, "pitch > octave");
      if (step === null || octave === null || !(step in STEP)) continue;
      const alter = Number(text(note, "pitch > alter") ?? 0);
      pitches.push((Number(octave) + 1) * 12 + STEP[step] + Math.round(alter));
      durations.push(dur);
      if (child(note, "accidental")) accidentals++;
    }
    totalBeats += measureBeats;
  }

  const n = pitches.length;
  if (n === 0) throw new Error("Aucune note trouvée dans la partition.");
  tempo ||= 90;
  const intervals = pitches.slice(1).map((p, i) => Math.abs(p - pitches[i]));
  if (intervals.length === 0) intervals.push(0);
  const seconds = totalBeats ? (totalBeats * 60) / tempo : n;
  const low = Math.min(...pitches);
  const high = Math.max(...pitches);

  const a: ScoreAnalysis = {
    title,
    composer,
    noteCount: n,
    lowMidi: low,
    highMidi: high,
    low: midiToName(low),
    high: midiToName(high),
    rangeSemitones: high - low,
    thirdOctaveRatio: round(pitches.filter((p) => p >= 84).length / n, 3),
    key: MAJOR_KEYS[fifths] ?? "?",
    fifths,
    time,
    tempo,
    accidentalRatio: round(accidentals / n, 3),
    shortestBeats: Math.min(...durations),
    notesPerSecond: round(n / seconds, 2),
    rhythmVariety: new Set(durations.map((d) => round(d, 3))).size,
    maxLeap: Math.max(...intervals),
    largeLeapRatio: round(intervals.filter((i) => i > 7).length / intervals.length, 3),
    awkwardRatio: round(pitches.filter((p) => AWKWARD.has(p)).length / n, 3),
    tuplets,
    ornaments,
    multiVoice: voices.size > 1,
    complexity: 0,
    level: 1,
  };
  a.complexity = complexityScore(a);
  a.level = levelFor(a.complexity);
  return a;
}

/** Mêmes poids que `complexity_score` (Python) — voir le tableau dans SKILL.md. */
export function complexityScore(a: ScoreAnalysis): number {
  const parts: [number, number][] = [
    [clamp01((a.rangeSemitones - 7) / 24), 14],
    [clamp01(a.thirdOctaveRatio / 0.3), 12],
    [clamp01(Math.abs(a.fifths) / 5), 10],
    [clamp01(a.accidentalRatio / 0.25), 10],
    [clamp01((a.notesPerSecond - 1) / 7), 18],
    [clamp01((1 - a.shortestBeats) / 0.75), 8],
    [clamp01((a.rhythmVariety - 2) / 6), 8],
    [clamp01(a.largeLeapRatio / 0.2) * 0.6 + clamp01((a.maxLeap - 7) / 17) * 0.4, 10],
    [clamp01(a.awkwardRatio / 0.2), 5],
    [clamp01((a.tuplets + a.ornaments) / Math.max(a.noteCount, 1) / 0.15), 5],
  ];
  const total = parts.reduce((s, [, w]) => s + w, 0);
  return Math.round((100 * parts.reduce((s, [v, w]) => s + v * w, 0)) / total);
}

export function levelFor(score: number): 1 | 2 | 3 | 4 | 5 {
  if (score < 15) return 1;
  if (score < 30) return 2;
  if (score < 48) return 3;
  if (score < 68) return 4;
  return 5;
}

/** Problèmes qui rendent une partition difficile à suivre note à note. */
export function scoreWarnings(a: ScoreAnalysis): string[] {
  const w: string[] = [];
  if (a.lowMidi < 59 || a.highMidi > 98) w.push(`notes hors de la tessiture de la flûte (${a.low}–${a.high})`);
  if (a.multiVoice) w.push("plusieurs voix superposées : seule la note la plus aiguë sera suivie");
  return w;
}
