/**
 * Transcription d'un enregistrement en partition (logique pure, testée). Les notes entendues
 * (début, durée, hauteur, force) viennent du modèle Basic Pitch (Spotify, Apache 2.0) ; ici on en
 * fait une partition lisible :
 * 1. nettoyage selon l'instrument (tessiture, une note à la fois pour la flûte et le violon) ;
 * 2. suivi des temps (programmation dynamique d'Ellis, 2007) : la pulsation suit le jeu, rubato
 *    compris, au lieu d'un tempo fixe qui dériverait ;
 * 3. chaque note est placée sur la grille des temps (double croche) ;
 * 4. tonalité estimée (profils de Krumhansl), orthographe des altérations en conséquence ;
 * 5. écriture MusicXML : mesures, silences, notes liées par-dessus les barres, accords et deux
 *    portées pour le piano.
 */

export type TranscribeInstrument = "flute" | "violin" | "piano";

/** Note entendue, en secondes. */
export interface HeardNote {
  start: number;
  duration: number;
  midi: number;
  /** Force (0–1). */
  amplitude: number;
}

/** Tessiture et réglages par instrument. */
export const INSTRUMENTS: Record<TranscribeInstrument, { label: string; low: number; high: number; mono: boolean; minHz: number; maxHz: number }> = {
  flute: { label: "Flûte", low: 59, high: 98, mono: true, minHz: 230, maxHz: 2400 },
  violin: { label: "Violon", low: 55, high: 103, mono: true, minHz: 185, maxHz: 3600 },
  piano: { label: "Piano", low: 21, high: 108, mono: false, minHz: 26, maxHz: 4300 },
};

/** Notes trop courtes ou trop faibles (souffle, bruit, harmoniques) écartées. */
const MIN_DURATION = 0.06;
const MIN_AMPLITUDE = 0.18;

/** Intervalles des premières harmoniques : octave, douzième, double octave, tierce au-dessus. */
const OVERTONES = [12, 19, 24, 28];

/**
 * Harmoniques prises pour des notes (piano) : une note nettement plus faible (moins des deux tiers), attaquée en même temps
 * qu'une note plus forte et située exactement sur l'une de ses harmoniques, est un fantôme.
 */
function withoutOvertones(notes: HeardNote[]): HeardNote[] {
  return notes.filter(
    (n) =>
      !notes.some(
        (f) =>
          f !== n &&
          OVERTONES.includes(n.midi - f.midi) &&
          Math.abs(f.start - n.start) < 0.06 &&
          n.amplitude < f.amplitude * 0.65,
      ),
  );
}

/**
 * Nettoyage : hors tessiture, trop court ou trop faible ; pour un instrument à une note (flûte,
 * violon), quand deux notes se chevauchent, la plus forte l'emporte (les harmoniques et les
 * octaves fantômes disparaissent) et la précédente s'arrête quand la suivante commence.
 */
export function cleanNotes(notes: HeardNote[], instrument: TranscribeInstrument): HeardNote[] {
  const ins = INSTRUMENTS[instrument];
  const kept = notes
    .filter((n) => n.midi >= ins.low && n.midi <= ins.high && n.duration >= MIN_DURATION && n.amplitude >= MIN_AMPLITUDE)
    .map((n) => ({ ...n }))
    .sort((a, b) => a.start - b.start || b.amplitude - a.amplitude);
  // polyphonique (piano) : les notes à la fois brèves et faibles sont la résonance des autres
  if (!ins.mono) return withoutOvertones(kept.filter((n) => !(n.duration < 0.3 && n.amplitude < 0.45)));
  const out: HeardNote[] = [];
  for (const n of kept) {
    const prev = out[out.length - 1];
    if (prev && n.start < prev.start + prev.duration - 0.03) {
      // chevauchement : une note qui commence presque en même temps et plus faible est un fantôme
      if (n.start - prev.start < 0.05 && n.amplitude <= prev.amplitude) continue;
      if (n.start - prev.start < 0.05 && n.amplitude > prev.amplitude) {
        out[out.length - 1] = n;
        continue;
      }
      // sinon la note précédente s'arrête là
      prev.duration = Math.max(0.03, n.start - prev.start);
    }
    out.push(n);
  }
  // même hauteur, sans silence, suivie d'un court fragment plus faible : une seule note coupée en
  // deux par l'écoute (une vraie note répétée est attaquée aussi fort que la précédente)
  const merged: HeardNote[] = [];
  for (const n of out) {
    const prev = merged[merged.length - 1];
    const fragment = n.duration < 0.25 && n.amplitude < prev?.amplitude * 0.92;
    if (prev && prev.midi === n.midi && fragment && n.start - (prev.start + prev.duration) < 0.025) {
      prev.duration = Math.max(prev.duration, n.start + n.duration - prev.start);
      prev.amplitude = Math.max(prev.amplitude, n.amplitude);
    } else merged.push(n);
  }
  return merged.filter((n) => n.duration >= MIN_DURATION / 2);
}

// --- Suivi des temps ----------------------------------------------------------------------

const ENV_RATE = 100; // images par seconde de l'enveloppe des attaques

/** Enveloppe des attaques : une impulsion (adoucie) par note, pesée par sa force. */
function onsetEnvelope(notes: HeardNote[], length: number): Float64Array {
  const env = new Float64Array(Math.max(1, Math.ceil(length * ENV_RATE) + 4));
  for (const n of notes) {
    const i = Math.round(n.start * ENV_RATE);
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < env.length) env[j] += (0.5 + n.amplitude) * Math.exp(-(k * k) / 2);
    }
  }
  return env;
}

/**
 * Période de la pulsation (en images) d'après les écarts entre attaques : le bon tempo est celui
 * qui les explique par des valeurs simples (1, 2, 3 temps, demi-temps…), avec une préférence pour
 * un tempo modéré (♩ ≈ 100) quand plusieurs conviennent.
 */
function pulsePeriod(notes: HeardNote[]): number {
  const starts = notes.map((n) => n.start).sort((a, b) => a - b);
  const iois = starts.slice(1).map((t, i) => t - starts[i]).filter((d) => d > 0.08);
  if (iois.length === 0) return (60 / 100) * ENV_RATE;
  let best = 100;
  let bestScore = -Infinity;
  for (let bpm = 40; bpm <= 200; bpm += 0.5) {
    const beat = 60 / bpm;
    let fit = 0;
    for (const d of iois) {
      const halves = d / (beat / 2);
      const k = Math.max(1, Math.round(halves));
      const err = halves - k;
      // ajustement à la grille des demi-temps, valeurs simples (peu de temps par écart) préférées
      fit += Math.exp(-(err * err) / (2 * 0.12 * 0.12)) / (1 + 0.08 * k) * (k % 2 === 0 ? 1 : 0.85);
    }
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 100) / 0.9) ** 2);
    const score = (fit / iois.length) * prior;
    if (score > bestScore) {
      bestScore = score;
      best = bpm;
    }
  }
  return (60 / best) * ENV_RATE;
}

/**
 * Instants des temps (secondes). `tempo` imposé (noires par minute) ou estimé. La pulsation peut
 * ralentir ou presser (programmation dynamique), mais reste proche de la période trouvée.
 */
export function trackBeats(notes: HeardNote[], tempo?: number): number[] {
  if (notes.length === 0) return [];
  const end = notes.reduce((m, n) => Math.max(m, n.start + n.duration), 0);
  const env = onsetEnvelope(notes, end);
  const period = tempo ? (60 / tempo) * ENV_RATE : pulsePeriod(notes);
  const tightness = tempo ? 400 : 100;
  const score = new Float64Array(env.length);
  const back = new Int32Array(env.length).fill(-1);
  for (let t = 0; t < env.length; t++) {
    let best = 0;
    let arg = -1;
    const from = Math.max(0, Math.round(t - 2 * period));
    const to = Math.round(t - period / 2);
    for (let p = from; p <= to; p++) {
      const v = score[p] - tightness * Math.log((t - p) / period) ** 2;
      if (arg < 0 || v > best) {
        best = v;
        arg = p;
      }
    }
    score[t] = env[t] + (arg >= 0 ? best : 0);
    back[t] = arg;
  }
  // dernier temps : le meilleur score près de la fin
  let t = env.length - 1;
  for (let i = Math.max(0, env.length - Math.round(period)); i < env.length; i++) if (score[i] > score[t]) t = i;
  const beats: number[] = [];
  while (t >= 0) {
    beats.push(t / ENV_RATE);
    t = back[t];
  }
  beats.reverse();
  // le premier temps : sur la première note (pas de temps dans le silence d'avant)
  const first = notes.reduce((m, n) => Math.min(m, n.start), Infinity);
  const P = period / ENV_RATE;
  const kept = beats.filter((b) => b > first - P / 3);
  beats.length = 0;
  for (const b of kept) beats.push(b);
  if (beats.length === 0 || beats[0] - first > P / 3) beats.unshift(first);
  else beats[0] = first;
  // assez de temps pour couvrir la fin
  const step = beats.length > 1 ? beats[beats.length - 1] - beats[beats.length - 2] : period / ENV_RATE;
  while (beats[beats.length - 1] < end) beats.push(beats[beats.length - 1] + step);
  return beats;
}

/** Tempo (noires par minute) d'une suite de temps : intervalle médian. */
export function tempoOf(beats: number[]): number {
  const gaps = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b);
  return gaps.length ? Math.round(60 / gaps[gaps.length >> 1]) : 100;
}

/** Position (en temps, fractionnaire) d'un instant sur la suite des temps. */
function beatPosition(beats: number[], t: number): number {
  if (t <= beats[0]) return (t - beats[0]) / (beats[1] - beats[0] || 1);
  let lo = 0;
  let hi = beats.length - 1;
  if (t >= beats[hi]) return hi + (t - beats[hi]) / (beats[hi] - beats[hi - 1] || 1);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - beats[lo]) / (beats[hi] - beats[lo]);
}

// --- Tonalité ------------------------------------------------------------------------------

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a: number[], b: number[]): number {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

/** Armure estimée (nombre de dièses > 0 ou de bémols < 0) et mode. */
export function estimateKey(notes: HeardNote[]): { fifths: number; mode: "major" | "minor" } {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[((n.midi % 12) + 12) % 12] += n.duration;
  let best = { fifths: 0, mode: "major" as "major" | "minor", r: -Infinity };
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile] of [["major", MAJOR], ["minor", MINOR]] as const) {
      const rotated = profile.map((_, i) => profile[(i - tonic + 12) % 12]);
      const r = correlation(hist, rotated);
      if (r > best.r) {
        // armure : position de la tonique (majeure) ou de sa relative majeure sur le cycle des quintes
        const major = mode === "major" ? tonic : (tonic + 3) % 12;
        let fifths = (major * 7) % 12;
        if (fifths > 6) fifths -= 12; // Fa♯ (6) plutôt que Sol♭ (−6)
        best = { fifths, mode, r };
      }
    }
  }
  return { fifths: best.fifths, mode: best.mode };
}

// --- Écriture ------------------------------------------------------------------------------

export interface TranscribeOptions {
  instrument: TranscribeInstrument;
  title: string;
  /** Tempo imposé (noires par minute) ; sinon estimé. */
  tempo?: number;
  beats: number;
  beatType: number;
  /** Plus petite valeur : 1 = double croche, 2 = croche. */
  grid: 1 | 2;
}

export interface Transcription {
  xml: string;
  tempo: number;
  fifths: number;
  mode: "major" | "minor";
  measures: number;
  notes: number;
}

/** Une note placée sur la grille (en doubles croches depuis le début). */
interface Placed {
  start: number;
  end: number;
  midi: number;
}

const DIVISIONS = 4; // doubles croches par noire

/** Durées écrites (en doubles croches) : type et point. */
const VALUES: [number, string, boolean][] = [
  [16, "whole", false],
  [12, "half", true],
  [8, "half", false],
  [6, "quarter", true],
  [4, "quarter", false],
  [3, "eighth", true],
  [2, "eighth", false],
  [1, "16th", false],
];

/** Découpe une durée en valeurs écrites, en respectant les temps (lisible). */
function splitDuration(start: number, length: number, beatTicks: number): number[] {
  const out: number[] = [];
  let pos = start;
  let left = length;
  while (left > 0) {
    // au milieu d'un temps : on complète d'abord le temps
    const inBeat = pos % beatTicks;
    const fit = inBeat ? Math.min(left, beatTicks - inBeat) : left;
    const v = VALUES.find(([d]) => d <= fit)![0];
    out.push(v);
    pos += v;
    left -= v;
  }
  return out;
}

const SHARP_NAMES: [string, number][] = [["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0]];
const FLAT_NAMES: [string, number][] = [["C", 0], ["D", -1], ["D", 0], ["E", -1], ["E", 0], ["F", 0], ["G", -1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0]];

function pitchXml(midi: number, fifths: number): string {
  const [step, alter] = (fifths < 0 ? FLAT_NAMES : SHARP_NAMES)[((midi % 12) + 12) % 12];
  const octave = Math.floor((midi - alter) / 12) - 1;
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch>`;
}

/**
 * Tranches de temps d'une portée : entre deux limites (débuts, fins, barres de mesure), l'ensemble
 * des notes qui sonnent ; une tranche vide = silence. Les notes qui continuent sont liées.
 */
function slices(notes: Placed[], total: number, measureTicks: number): { start: number; end: number; midis: number[] }[] {
  const bounds = new Set<number>([0, total]);
  for (const n of notes) bounds.add(n.start).add(n.end);
  for (let b = measureTicks; b < total; b += measureTicks) bounds.add(b);
  const sorted = [...bounds].filter((b) => b >= 0 && b <= total).sort((a, b) => a - b);
  const out: { start: number; end: number; midis: number[] }[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const [a, b] = [sorted[i], sorted[i + 1]];
    const midis = notes.filter((n) => n.start < b && n.end > a).map((n) => n.midi).sort((x, y) => x - y);
    const prev = out[out.length - 1];
    // même ensemble, sans barre de mesure ni nouvelle attaque entre les deux : une seule tranche
    const reattack = notes.some((n) => n.start === a);
    if (prev && a % measureTicks !== 0 && !reattack && prev.midis.join() === midis.join()) prev.end = b;
    else out.push({ start: a, end: b, midis });
  }
  return out;
}

function staffXml(notes: Placed[], total: number, measureTicks: number, beatTicks: number, fifths: number, staff: number | null): string[] {
  const perMeasure: string[] = Array.from({ length: Math.ceil(total / measureTicks) }, () => "");
  const sl = slices(notes, total, measureTicks);
  sl.forEach((s, i) => {
    const m = Math.floor(s.start / measureTicks);
    const prev = sl[i - 1];
    const next = sl[i + 1];
    const values = splitDuration(s.start, s.end - s.start, beatTicks);
    let pos = s.start;
    values.forEach((v, k) => {
      const [, type, dot] = VALUES.find(([d]) => d === v)!;
      const staffTag = staff ? `<staff>${staff}</staff>` : "";
      if (s.midis.length === 0) {
        // mesure entière de silence : un silence de mesure
        const whole = s.start % measureTicks === 0 && s.end - s.start === measureTicks;
        perMeasure[m] += whole
          ? `<note><rest measure="yes"/><duration>${measureTicks}</duration>${staffTag}</note>`
          : `<note><rest/><duration>${v}</duration><type>${type}</type>${dot ? "<dot/>" : ""}${staffTag}</note>`;
        if (whole) values.length = k + 1; // (le silence de mesure couvre tout)
      } else {
        s.midis.forEach((midi, c) => {
          // liaison : avec la tranche précédente/suivante si la note continue, ou entre deux morceaux de la tranche
          const fromPrev = (k > 0) || (!!prev && prev.end === s.start && prev.midis.includes(midi) && !notes.some((n) => n.midi === midi && n.start === s.start));
          const toNext = (k < values.length - 1) || (!!next && next.start === s.end && next.midis.includes(midi) && !notes.some((n) => n.midi === midi && n.start === s.end));
          const ties = `${fromPrev ? '<tie type="stop"/>' : ""}${toNext ? '<tie type="start"/>' : ""}`;
          const tied = fromPrev || toNext ? `<notations>${fromPrev ? '<tied type="stop"/>' : ""}${toNext ? '<tied type="start"/>' : ""}</notations>` : "";
          perMeasure[m] += `<note>${c > 0 ? "<chord/>" : ""}${pitchXml(midi, fifths)}<duration>${v}</duration>${ties}<type>${type}</type>${dot ? "<dot/>" : ""}${staffTag}${tied}</note>`;
        });
      }
      pos += v;
    });
  });
  return perMeasure;
}

/** Place les notes entendues sur la grille des temps (doubles croches, ou croches). */
export function placeNotes(notes: HeardNote[], beats: number[], beatTicks: number, grid: 1 | 2): Placed[] {
  const round = (pos: number) => Math.max(0, Math.round((pos * beatTicks) / grid) * grid);
  const placed = notes
    .map((n) => {
      const start = round(beatPosition(beats, n.start));
      const end = Math.max(start + grid, round(beatPosition(beats, n.start + n.duration)));
      return { start, end, midi: n.midi };
    })
    .sort((a, b) => a.start - b.start || a.midi - b.midi);
  // deux attaques de la même hauteur au même endroit : une seule note
  const out: Placed[] = [];
  for (const p of placed) {
    const same = out.find((o) => o.midi === p.midi && o.start === p.start);
    if (same) same.end = Math.max(same.end, p.end);
    else out.push(p);
  }
  // une même hauteur ne se chevauche pas elle-même
  for (const p of out) {
    const next = out.find((o) => o.midi === p.midi && o.start > p.start && o.start < p.end);
    if (next) p.end = next.start;
  }
  return out;
}

/**
 * Monodique : chaque note s'arrête au plus tard quand la suivante commence ; une note détachée
 * (petit silence de moins d'un demi-temps avant la suivante, ou avant le temps suivant pour la
 * dernière) est écrite jusqu'à la suivante : on écrit la valeur, pas l'articulation.
 */
function monophonic(placed: Placed[], beatTicks: number): Placed[] {
  const out: Placed[] = [];
  for (const p of placed) {
    const prev = out[out.length - 1];
    if (prev && prev.start === p.start) continue;
    if (prev && prev.end > p.start) prev.end = p.start;
    out.push({ ...p });
  }
  const half = beatTicks / 2;
  out.forEach((p, i) => {
    const next = out[i + 1];
    const target = next ? next.start : Math.ceil(p.end / beatTicks) * beatTicks;
    if (target > p.end && target - p.end <= half) p.end = target;
  });
  return out.filter((p) => p.end > p.start);
}

/**
 * Piano : une note qui résonne encore un peu sous la suivante de la même main (legato, pédale)
 * s'arrête quand la suivante commence, si le chevauchement est court (moins d'un demi-temps) ;
 * un vrai accord tenu (chevauchement long) est gardé.
 */
function trimLegato(placed: Placed[], beatTicks: number): Placed[] {
  const out = placed.map((p) => ({ ...p }));
  for (const p of out) {
    const next = out.find((q) => q.start > p.start && q.start < p.end && q.midi !== p.midi);
    if (next && p.end - next.start <= beatTicks / 2) p.end = next.start;
  }
  return out;
}

export function transcribe(heard: HeardNote[], options: TranscribeOptions): Transcription {
  const ins = INSTRUMENTS[options.instrument];
  const notes = cleanNotes(heard, options.instrument);
  if (notes.length === 0) throw new Error("Aucune note n'a été reconnue dans cet enregistrement.");
  const compound = options.beatType === 8 && options.beats % 3 === 0;
  // temps suivis : noires (x/4), noires pointées (6/8, 9/8, 12/8), blanches (2/2)
  const beatTicks = compound ? 6 : (DIVISIONS * 4) / options.beatType;
  const trackedTempo = options.tempo ? (options.tempo * 4) / ((beatTicks / DIVISIONS) * 4) : undefined;
  const beats = trackBeats(notes, trackedTempo);
  let placed = placeNotes(notes, beats, beatTicks, options.grid);
  if (ins.mono) placed = monophonic(placed, beatTicks);
  const measureTicks = (options.beats * DIVISIONS * 4) / options.beatType;
  const last = placed.reduce((m, p) => Math.max(m, p.end), 0);
  const total = Math.ceil(last / measureTicks) * measureTicks;
  const { fifths, mode } = estimateKey(notes);
  const beatTempo = tempoOf(beats);
  // tempo écrit, en noires par minute
  const tempo = Math.round(beatTempo * (beatTicks / DIVISIONS));

  const piano = options.instrument === "piano";
  const staves = piano
    ? [
        staffXml(trimLegato(placed.filter((p) => p.midi >= 60), beatTicks), total, measureTicks, beatTicks, fifths, 1),
        staffXml(trimLegato(placed.filter((p) => p.midi < 60), beatTicks), total, measureTicks, beatTicks, fifths, 2),
      ]
    : [staffXml(placed, total, measureTicks, beatTicks, fifths, null)];
  const measures = staves[0].map((_, m) => {
    const attrs =
      m === 0
        ? `<attributes><divisions>${DIVISIONS}</divisions><key><fifths>${fifths}</fifths><mode>${mode}</mode></key><time><beats>${options.beats}</beats><beat-type>${options.beatType}</beat-type></time>${
            piano ? `<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>` : `<clef><sign>G</sign><line>2</line></clef>`
          }</attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>`
        : "";
    const body = piano ? `${staves[0][m]}<backup><duration>${measureTicks}</duration></backup>${staves[1][m]}` : staves[0][m];
    return `<measure number="${m + 1}">${attrs}${body}</measure>`;
  });
  const partName = piano ? "Piano" : options.instrument === "violin" ? "Flûte (transcrit du violon)" : "Flûte";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1"><work><work-title>${esc(options.title)}</work-title></work><identification><creator type="composer">Transcription automatique</creator></identification><part-list><score-part id="P1"><part-name>${partName}</part-name></score-part></part-list><part id="P1">${measures.join("")}</part></score-partwise>`;
  return { xml, tempo, fifths, mode, measures: measures.length, notes: placed.length };
}
