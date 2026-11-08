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
  /**
   * Creux de volume juste avant l'attaque (volume avant / volume après, 0–1), mesuré dans
   * l'enregistrement : bas pour une vraie attaque (coup de langue), proche de 1 quand l'écoute a
   * seulement coupé une note tenue en deux. Absent si inconnu.
   */
  dip?: number;
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
 * Ligne mélodique (flûte, violon) parmi toutes les notes entendues, accompagnement compris
 * (piano, orchestre) : programmation dynamique qui choisit une suite de notes sans
 * chevauchement, en privilégiant les notes longues, fortes et aiguës (la flûte joue le plus
 * souvent au-dessus) et les enchaînements sans grand saut (les sauts vers l'accompagnement
 * coûtent).
 */
export function extractMelody(candidates: HeardNote[]): HeardNote[] {
  const c = [...candidates].sort((a, b) => a.start - b.start || b.amplitude - a.amplitude);
  const n = c.length;
  if (n === 0) return [];
  const value = (x: HeardNote) => x.duration * (0.3 + x.amplitude) * Math.max(0.3, 1 + 0.025 * (x.midi - 72));
  const jumpCost = (a: HeardNote, b: HeardNote) => 0.015 * Math.max(0, Math.abs(a.midi - b.midi) - 4);
  const WINDOW = 4; // secondes
  const dp = new Float64Array(n);
  const prev = new Int32Array(n).fill(-1);
  let far = 0;
  let farBest = 0;
  let farArg = -1;
  for (let i = 0; i < n; i++) {
    const x = c[i];
    while (far < i && c[far].start <= x.start - WINDOW) {
      if (dp[far] > farBest) {
        farBest = dp[far];
        farArg = far;
      }
      far++;
    }
    let best = farBest;
    let arg = farArg;
    for (let j = i - 1; j >= far; j--) {
      const y = c[j];
      // une note avant celle-ci (un léger chevauchement est toléré : le son se prolonge)
      if (y.start >= x.start - 0.03 || y.start + y.duration > x.start + Math.min(0.15, 0.5 * y.duration)) continue;
      const v = dp[j] - jumpCost(y, x);
      if (v > best) {
        best = v;
        arg = j;
      }
    }
    dp[i] = value(x) + Math.max(0, best);
    prev[i] = best > 0 ? arg : -1;
  }
  let end = 0;
  for (let i = 1; i < n; i++) if (dp[i] > dp[end]) end = i;
  const line: HeardNote[] = [];
  for (let i = end; i >= 0; i = prev[i]) line.push({ ...c[i] });
  return line.reverse();
}

/**
 * Nettoyage : hors tessiture, trop court ou trop faible ; pour un instrument à une note (flûte,
 * violon), la ligne mélodique (voir `extractMelody`), puis chaque note s'arrête quand la
 * suivante commence.
 */
export function cleanNotes(notes: HeardNote[], instrument: TranscribeInstrument): HeardNote[] {
  const ins = INSTRUMENTS[instrument];
  const kept = notes
    .filter((n) => n.midi >= ins.low && n.midi <= ins.high && n.duration >= MIN_DURATION && n.amplitude >= MIN_AMPLITUDE)
    .map((n) => ({ ...n }))
    .sort((a, b) => a.start - b.start || b.amplitude - a.amplitude);
  // polyphonique (piano) : les notes à la fois brèves et faibles sont la résonance des autres
  if (!ins.mono) return withoutOvertones(kept.filter((n) => !(n.duration < 0.3 && n.amplitude < 0.45)));
  // une note à la fois : la ligne de la flûte (ou du violon) parmi l'accompagnement et les harmoniques
  const line = extractMelody(withoutOvertones(kept));
  const out: HeardNote[] = [];
  for (const n of line) {
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
  // même hauteur, sans nouvelle attaque (pas de creux de volume) : une seule note coupée en deux
  // par l'écoute ; une note répétée (coup de langue) reste répétée
  const merged: HeardNote[] = [];
  for (const n of out) {
    const prev = merged[merged.length - 1];
    const gap = prev ? n.start - (prev.start + prev.duration) : 1;
    // sans creux de volume avant elle, ce n'est pas une nouvelle attaque ; à défaut de mesure,
    // un court fragment plus faible qui chevauche la note précédente
    const continuation =
      n.dip !== undefined ? n.dip > 0.75 && gap < 0.03 : n.duration < 0.25 && n.amplitude < (prev?.amplitude ?? 0) * 0.92 && gap < -0.004;
    if (prev && prev.midi === n.midi && continuation) {
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
      // ajustement à la grille des demi-temps ou des tiers de temps (triolets), valeurs simples
      // (peu de temps par écart, temps entiers) préférées
      const halves = d / (beat / 2);
      const k = Math.max(1, Math.round(halves));
      const err = halves - k;
      const binary = (Math.exp(-(err * err) / (2 * 0.12 * 0.12)) / (1 + 0.08 * k)) * (k % 2 === 0 ? 1 : 0.85);
      const thirds = d / (beat / 3);
      const kt = Math.max(1, Math.round(thirds));
      const errT = thirds - kt;
      const ternary = (Math.exp(-(errT * errT) / (2 * 0.12 * 0.12)) / (1 + 0.08 * (kt * 2) / 3)) * (kt % 3 === 0 ? 1 : 0.8);
      fit += Math.max(binary, ternary);
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
  /** Triolets reconnus (temps joués en trois). */
  triplets?: boolean;
}

export interface Transcription {
  xml: string;
  tempo: number;
  fifths: number;
  mode: "major" | "minor";
  measures: number;
  notes: number;
  /** Temps de levée (anacrouse) avant la première barre de mesure. */
  pickupBeats: number;
}

/** Une note placée (en unités : 12 par noire, pour les doubles croches et les triolets). */
interface Placed {
  start: number;
  end: number;
  midi: number;
}

const DIVISIONS = 12; // unités par noire

/** Durées écrites hors triolet (en unités) : type et point. */
const VALUES: [number, string, boolean][] = [
  [48, "whole", false],
  [36, "half", true],
  [24, "half", false],
  [18, "quarter", true],
  [12, "quarter", false],
  [9, "eighth", true],
  [6, "eighth", false],
  [3, "16th", false],
];

const SHARP_NAMES: [string, number][] = [["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0]];
const FLAT_NAMES: [string, number][] = [["C", 0], ["D", -1], ["D", 0], ["E", -1], ["E", 0], ["F", 0], ["G", -1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0]];

function pitchXml(midi: number, fifths: number): string {
  const [step, alter] = (fifths < 0 ? FLAT_NAMES : SHARP_NAMES)[((midi % 12) + 12) % 12];
  const octave = Math.floor((midi - alter) / 12) - 1;
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch>`;
}

/** Grille rythmique : temps (en unités), pas binaire, temps joués en triolet. */
interface Grid {
  beatTicks: number;
  step: number;
  triplet: Set<number>;
}

/**
 * Temps joués en triolet : au moins deux attaques dans le temps, mieux placées sur les tiers que
 * sur la grille binaire (nettement : en cas de doute, binaire).
 */
export function findTriplets(positions: number[], beatTicks: number, step: number): Set<number> {
  const out = new Set<number>();
  if (beatTicks !== 12) return out; // triolets de croches dans un temps d'une noire
  const byBeat = new Map<number, number[]>();
  for (const p of positions) {
    const k = Math.floor(p + 1e-6);
    const f = p - k;
    if (f > 0.04 && f < 0.96) byBeat.set(k, [...(byBeat.get(k) ?? []), f]);
  }
  for (const [k, fs] of byBeat) {
    const err = (f: number, unit: number) => {
      const x = f / unit;
      return Math.abs(x - Math.round(x)) * unit;
    };
    const binary = fs.reduce((s, f) => s + err(f, step / beatTicks), 0);
    const ternary = fs.reduce((s, f) => s + err(f, 1 / 3), 0);
    const onThirds = fs.some((f) => Math.abs(f - 1 / 3) < 0.07 || Math.abs(f - 2 / 3) < 0.07);
    if (onThirds && ternary < binary * 0.5) out.add(k);
  }
  return out;
}

/** Position (en temps) → unité de la grille (arrondie au pas du temps : binaire ou triolet). */
function snap(pos: number, g: Grid): number {
  const k = Math.floor(pos);
  const step = g.triplet.has(k) ? 4 : g.step;
  const ticks = Math.round(((pos - k) * g.beatTicks) / step) * step;
  return Math.max(0, k * g.beatTicks + ticks);
}

/**
 * Premier temps de la mesure : le décalage (en temps) qui place sur les premiers temps le plus de
 * poids — notes longues et fortes, basses de l'accompagnement. 0 sauf si un autre décalage est
 * nettement meilleur (levée, ou anacrouse).
 */
export function downbeatOffset(notes: HeardNote[], beats: number[], beatsPerMeasure: number): number {
  if (beatsPerMeasure <= 1 || beats.length < 2) return 0;
  const score = new Array(beatsPerMeasure).fill(0);
  // fin de chaque note, par hauteur : une note qui en prolonge une autre (même hauteur, sans
  // silence — basse tenue coupée en deux à l'arrivée d'un accord) n'est pas une attaque
  const ends = new Map<number, number[]>();
  for (const n of notes) ends.set(n.midi, [...(ends.get(n.midi) ?? []), n.start + n.duration]);
  const attacks = notes.filter((n) => !(ends.get(n.midi) ?? []).some((e) => Math.abs(e - n.start) < 0.03));
  // avec un accompagnement, les basses marquent le premier temps (« basse, accord, accord ») ;
  // sinon (flûte seule), ce sont les notes longues
  const bass = attacks.filter((n) => n.midi < 55);
  const useBass = bass.length >= 4;
  for (const n of useBass ? bass : attacks) {
    const pos = beatPosition(beats, n.start);
    const b = Math.round(pos);
    if (Math.abs(pos - b) > 0.15 || b < 0) continue;
    score[b % beatsPerMeasure] += useBass ? 0.3 + n.amplitude : (0.3 + n.amplitude) * Math.min(2, n.duration);
  }
  let best = 0;
  for (let r = 1; r < beatsPerMeasure; r++) if (score[r] > score[best]) best = r;
  return best !== 0 && score[best] > score[0] * 1.25 ? best : 0;
}

/** Place les notes sur la grille (unités), une même hauteur sans chevauchement. */
function placeNotes(notes: HeardNote[], beats: number[], g: Grid): Placed[] {
  const placed = notes
    .map((n) => {
      const start = snap(beatPosition(beats, n.start), g);
      const minStep = g.triplet.has(Math.floor(start / g.beatTicks)) ? 4 : g.step;
      const end = Math.max(start + minStep, snap(beatPosition(beats, n.start + n.duration), g));
      return { start, end, midi: n.midi };
    })
    .sort((a, b) => a.start - b.start || a.midi - b.midi);
  const out: Placed[] = [];
  for (const p of placed) {
    const same = out.find((o) => o.midi === p.midi && o.start === p.start);
    if (same) same.end = Math.max(same.end, p.end);
    else out.push(p);
  }
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

/** Morceaux d'une durée : valeurs écrites, en complétant d'abord le temps entamé ; triolets à part. */
function splitDuration(start: number, length: number, g: Grid): { v: number; tuplet: boolean }[] {
  const out: { v: number; tuplet: boolean }[] = [];
  let pos = start;
  let left = length;
  while (left > 0) {
    const k = Math.floor(pos / g.beatTicks);
    const beatEnd = (k + 1) * g.beatTicks;
    if (g.triplet.has(k)) {
      const room = Math.min(left, beatEnd - pos);
      // temps entier : une noire ordinaire ; sinon croches (4) ou noires (8) de triolet
      const v = pos % g.beatTicks === 0 && room === g.beatTicks ? g.beatTicks : room >= 8 ? 8 : 4;
      out.push({ v, tuplet: v !== g.beatTicks });
      pos += v;
      left -= v;
      continue;
    }
    const inBeat = pos % g.beatTicks;
    let fit = inBeat ? Math.min(left, beatEnd - pos) : left;
    // pas de valeur longue qui empiète sur un temps en triolet
    for (let b = k + 1; b * g.beatTicks < pos + fit; b++) if (g.triplet.has(b)) fit = Math.min(fit, b * g.beatTicks - pos);
    const v = VALUES.find(([d]) => d <= fit)?.[0] ?? 3;
    out.push({ v, tuplet: false });
    pos += v;
    left -= v;
  }
  return out;
}

function staffXml(notes: Placed[], measures: [number, number][], g: Grid, fifths: number, staff: number | null): string[] {
  const out: string[] = measures.map(() => "");
  const total = measures[measures.length - 1][1];
  const hard = new Set<number>(measures.map(([a]) => a));
  for (const k of g.triplet) {
    hard.add(k * g.beatTicks);
    hard.add((k + 1) * g.beatTicks);
  }
  const bounds = new Set<number>([0, total, ...hard]);
  for (const n of notes) bounds.add(n.start).add(Math.min(n.end, total));
  const sorted = [...bounds].filter((b) => b >= 0 && b <= total).sort((a, b) => a - b);
  // tranches : on ne fusionne pas par-dessus une limite « dure » (barre, temps en triolet)
  const raw: { start: number; end: number; midis: number[]; hard?: boolean }[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const [a, b] = [sorted[i], sorted[i + 1]];
    raw.push({ start: a, end: b, midis: notes.filter((n) => n.start < b && n.end > a).map((n) => n.midi).sort((x, y) => x - y), hard: hard.has(a) });
  }
  const sl: typeof raw = [];
  for (const s of raw) {
    const prev = sl[sl.length - 1];
    if (prev && !s.hard && prev.midis.join() === s.midis.join() && !notes.some((n) => n.start === s.start)) prev.end = s.end;
    else sl.push({ ...s });
  }
  const measureOf = (t: number) => measures.findIndex(([a, b]) => t >= a && t < b);
  sl.forEach((s, i) => {
    const m = measureOf(s.start);
    if (m < 0) return;
    const prev = sl[i - 1];
    const next = sl[i + 1];
    const [mStart, mEnd] = measures[m];
    const staffTag = staff ? `<staff>${staff}</staff>` : "";
    if (s.midis.length === 0 && s.start === mStart && s.end === mEnd && mEnd - mStart > 0 && m > 0) {
      out[m] += `<note><rest measure="yes"/><duration>${mEnd - mStart}</duration>${staffTag}</note>`;
      return;
    }
    const parts = splitDuration(s.start, s.end - s.start, g);
    let pos = s.start;
    parts.forEach(({ v, tuplet }, k) => {
      const type = tuplet ? (v === 8 ? "quarter" : "eighth") : VALUES.find(([d]) => d === v)![1];
      const dot = !tuplet && VALUES.find(([d]) => d === v)![2];
      const beat = Math.floor(pos / g.beatTicks);
      const tm = tuplet ? "<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>" : "";
      const tupletStart = tuplet && pos === beat * g.beatTicks;
      const tupletStop = tuplet && pos + v === (beat + 1) * g.beatTicks;
      const tupletTags = `${tupletStart ? '<tuplet type="start" bracket="yes"/>' : ""}${tupletStop ? '<tuplet type="stop"/>' : ""}`;
      if (s.midis.length === 0) {
        out[m] += `<note><rest/><duration>${v}</duration><type>${type}</type>${dot ? "<dot/>" : ""}${tm}${staffTag}${tupletTags ? `<notations>${tupletTags}</notations>` : ""}</note>`;
      } else {
        s.midis.forEach((midi, c) => {
          const fromPrev = k > 0 || (!!prev && prev.end === s.start && prev.midis.includes(midi) && !notes.some((n) => n.midi === midi && n.start === s.start));
          const toNext = k < parts.length - 1 || (!!next && next.start === s.end && next.midis.includes(midi) && !notes.some((n) => n.midi === midi && n.start === s.end));
          const ties = `${fromPrev ? '<tie type="stop"/>' : ""}${toNext ? '<tie type="start"/>' : ""}`;
          const tied = `${fromPrev ? '<tied type="stop"/>' : ""}${toNext ? '<tied type="start"/>' : ""}`;
          const notations = tied || (c === 0 && tupletTags) ? `<notations>${tied}${c === 0 ? tupletTags : ""}</notations>` : "";
          out[m] += `<note>${c > 0 ? "<chord/>" : ""}${pitchXml(midi, fifths)}<duration>${v}</duration>${ties}<type>${type}</type>${dot ? "<dot/>" : ""}${tm}${staffTag}${notations}</note>`;
        });
      }
      pos += v;
    });
  });
  return out;
}

export function transcribe(heard: HeardNote[], options: TranscribeOptions): Transcription {
  const ins = INSTRUMENTS[options.instrument];
  const notes = cleanNotes(heard, options.instrument);
  if (notes.length === 0) throw new Error("Aucune note n'a été reconnue dans cet enregistrement.");
  // toutes les notes entendues (accompagnement compris) : pulsation, premier temps, tonalité
  const all = INSTRUMENTS[options.instrument].mono ? withoutOvertones(heard.filter((n) => n.duration >= MIN_DURATION && n.amplitude >= MIN_AMPLITUDE)) : notes;
  const rhythmNotes = all.length >= notes.length ? all : notes;
  const compound = options.beatType === 8 && options.beats % 3 === 0;
  // temps suivis : noires (x/4), noires pointées (6/8, 9/8, 12/8), blanches (2/2)
  const beatTicks = compound ? 18 : (DIVISIONS * 4) / options.beatType;
  const trackedTempo = options.tempo ? options.tempo / (beatTicks / DIVISIONS) : undefined;
  const beats = trackBeats(rhythmNotes, trackedTempo);
  const step = (beatTicks === 18 ? 3 : beatTicks / 4) * options.grid;
  const positions = notes.map((n) => beatPosition(beats, n.start));
  const g: Grid = { beatTicks, step: Math.max(3, step), triplet: options.triplets === false ? new Set() : findTriplets(positions, beatTicks, Math.max(3, step)) };
  let placed = placeNotes(notes, beats, g);
  if (ins.mono) placed = monophonic(placed, beatTicks);
  const beatsPerMeasure = compound ? options.beats / 3 : options.beats;
  const pickup = downbeatOffset(rhythmNotes, beats, beatsPerMeasure);
  const measureTicks = (options.beats * DIVISIONS * 4) / options.beatType;
  const offset = pickup * beatTicks;
  const last = placed.reduce((m, p) => Math.max(m, p.end), 0);
  const measures: [number, number][] = [];
  if (offset > 0) measures.push([0, offset]);
  for (let a = offset; a < last; a += measureTicks) measures.push([a, a + measureTicks]);
  const { fifths, mode } = estimateKey(all.length ? all : notes);
  const tempo = Math.round(tempoOf(beats) * (beatTicks / DIVISIONS));

  const piano = options.instrument === "piano";
  const staves = piano
    ? [
        staffXml(trimLegato(placed.filter((p) => p.midi >= 60), beatTicks), measures, g, fifths, 1),
        staffXml(trimLegato(placed.filter((p) => p.midi < 60), beatTicks), measures, g, fifths, 2),
      ]
    : [staffXml(placed, measures, g, fifths, null)];
  const body = measures.map(([a, b], m) => {
    const attrs =
      m === 0
        ? `<attributes><divisions>${DIVISIONS}</divisions><key><fifths>${fifths}</fifths><mode>${mode}</mode></key><time><beats>${options.beats}</beats><beat-type>${options.beatType}</beat-type></time>${
            piano ? `<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>` : `<clef><sign>G</sign><line>2</line></clef>`
          }</attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>`
        : "";
    const content = piano ? `${staves[0][m]}<backup><duration>${b - a}</duration></backup>${staves[1][m]}` : staves[0][m];
    // levée : mesure incomplète, non comptée
    const number = offset > 0 ? m : m + 1;
    return `<measure number="${number}"${offset > 0 && m === 0 ? ' implicit="yes"' : ""}>${attrs}${content}</measure>`;
  });
  const partName = piano ? "Piano" : options.instrument === "violin" ? "Flûte (transcrit du violon)" : "Flûte";
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1"><work><work-title>${esc(options.title)}</work-title></work><identification><creator type="composer">Transcription automatique</creator></identification><part-list><score-part id="P1"><part-name>${partName}</part-name></score-part></part-list><part id="P1">${body.join("")}</part></score-partwise>`;
  return { xml, tempo, fifths, mode, measures: measures.length - (offset > 0 ? 1 : 0), notes: placed.length, pickupBeats: pickup };
}
