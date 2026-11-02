import { midiToName } from "./notes";

/**
 * Bilan de justesse (logique pure, testée) : pendant que vous tenez chaque note, l'écart en cents
 * entre ce que le micro entend et la note écrite est relevé, puis moyenné par note (Mi6, La4…).
 * Les toutes premières mesures après l'attaque sont ignorées (le son n'est pas encore stable),
 * ainsi que les sons trop loin de la note (autre note, souffle) : on ne juge que la note tenue.
 */

/** Mesures du micro ignorées juste après l'attaque (≈ 70 ms). */
export const SKIP_AFTER_ATTACK = 3;
/** Au-delà de cet écart, ce n'est plus la note tenue (glissement vers la suivante, bruit). */
const MAX_CENTS = 60;
/** Mesures minimales pour juger une note (≈ 0,2 s tenue en tout). */
const MIN_FRAMES = 8;
/** Écart moyen à partir duquel une note est signalée. */
export const OFF_CENTS = 10;

export interface NoteIntonation {
  midi: number;
  name: string;
  /** Écart moyen en cents (+ = trop haut). */
  cents: number;
  frames: number;
}

export interface IntonationReport {
  /** Notes jouées assez longtemps pour être jugées, de la plus fausse à la plus juste. */
  notes: NoteIntonation[];
  /** Écart moyen (en valeur absolue) sur toutes les mesures, en cents. */
  meanAbs: number;
}

export class IntonationTracker {
  private sums = new Map<number, { sum: number; n: number }>();
  private all = { sumAbs: 0, n: 0 };
  private current: { index: number; frames: number } | null = null;

  /** Une nouvelle note vient d'être reconnue : ses premières mesures ne comptent pas. */
  noteStarted(index: number): void {
    this.current = { index, frames: 0 };
  }

  /**
   * Mesure du micro pendant la note `index` (attendue : `expectedMidi`) ; `heardMidi` : hauteur
   * entendue (fractionnaire), ou null pour un silence.
   */
  frame(index: number, expectedMidi: number, heardMidi: number | null): void {
    if (!this.current || this.current.index !== index || heardMidi === null) return;
    this.current.frames++;
    if (this.current.frames <= SKIP_AFTER_ATTACK) return;
    const cents = (heardMidi - expectedMidi) * 100;
    if (Math.abs(cents) > MAX_CENTS) return;
    const s = this.sums.get(expectedMidi) ?? { sum: 0, n: 0 };
    s.sum += cents;
    s.n++;
    this.sums.set(expectedMidi, s);
    this.all.sumAbs += Math.abs(cents);
    this.all.n++;
  }

  reset(): void {
    this.sums.clear();
    this.all = { sumAbs: 0, n: 0 };
    this.current = null;
  }

  get report(): IntonationReport {
    const notes = [...this.sums]
      .filter(([, s]) => s.n >= MIN_FRAMES)
      .map(([midi, s]) => ({ midi, name: midiToName(midi), cents: Math.round(s.sum / s.n), frames: s.n }))
      .sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents) || a.midi - b.midi);
    return { notes, meanAbs: this.all.n ? Math.round(this.all.sumAbs / this.all.n) : 0 };
  }
}

/** Phrases de bilan : les notes les plus fausses (au plus `max`), ou un compliment. */
export function intonationSummary(r: IntonationReport, max = 4): { headline: string; details: string[] } {
  if (r.notes.length === 0) return { headline: "Justesse : pas assez de notes tenues pour juger.", details: [] };
  const off = r.notes.filter((n) => Math.abs(n.cents) >= OFF_CENTS).slice(0, max);
  const headline =
    off.length === 0
      ? `Justesse : très bien, toutes vos notes sont justes (écart moyen ${r.meanAbs} cents).`
      : `Justesse : écart moyen ${r.meanAbs} cents. À travailler :`;
  const details = off.map(
    (n) => `${n.name} trop ${n.cents > 0 ? "haut" : "bas"} de ${Math.abs(n.cents)} cents${n.cents > 0 ? " : couvrez un peu plus l'embouchure, soufflez moins fort" : " : découvrez un peu l'embouchure, soufflez plus vite"}`,
  );
  return { headline, details };
}
