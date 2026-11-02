/**
 * Outils de travail (logique pure, sans audio ni DOM, testée) :
 * - boucle sur un passage (mesures choisies), avec tempo qui monte après chaque passage réussi ;
 * - décompte avant de jouer (une mesure de clics) ;
 * - évaluation du rythme : chaque attaque est-elle en avance, à l'heure, en retard ?
 */

export interface StepTiming {
  /** Indice de la mesure (0 = première mesure de la partition). */
  measure: number;
  /** Début, en secondes au tempo écrit. */
  startSec: number;
}

/** Notes (indices) du passage allant de la mesure `from` à la mesure `to` (numéros 1, 2, 3…). */
export function stepRange(steps: readonly StepTiming[], from: number, to: number): { first: number; last: number } | null {
  const lo = Math.min(from, to) - 1;
  const hi = Math.max(from, to) - 1;
  const first = steps.findIndex((s) => s.measure >= lo && s.measure <= hi);
  if (first < 0) return null;
  let last = first;
  while (last + 1 < steps.length && steps[last + 1].measure <= hi) last++;
  return { first, last };
}

/** Écart de tempo ajouté après un passage réussi (noires par minute). */
export const TEMPO_STEP = 4;

/** Tempo du passage suivant : il monte après un passage réussi, sans dépasser l'objectif. */
export function nextLoopTempo(current: number, target: number, success: boolean, step = TEMPO_STEP): number {
  if (!success || current >= target) return current;
  return Math.min(target, current + step);
}

/**
 * Décompte : une mesure de clics au tempo choisi (noires par minute). `beats` / `beatType` :
 * la signature de la mesure (6/8 → 6 croches). Renvoie le nombre de clics et leur écart (s).
 */
export function countIn(beats: number, beatType: number, quarterTempo: number): { clicks: number; beatSec: number } {
  const clicks = Math.max(1, Math.min(12, Math.round(beats) || 4));
  const unit = beatType > 0 ? 4 / beatType : 1; // durée du temps, en noires
  return { clicks, beatSec: (60 / quarterTempo) * unit };
}

export type RhythmVerdict = "early" | "on" | "late";

export interface RhythmReport {
  /** Notes évaluées (la première d'une phrase, après une pause, ne l'est pas). */
  evaluated: number;
  onTime: number;
  early: number;
  late: number;
  /** Part des notes à l'heure, 0 → 100. */
  percent: number;
}

/**
 * Rythme : chaque attaque est comparée à l'instant où elle était attendue d'après le tempo
 * de l'élève lui-même (mesuré sur ses dernières notes), pas d'après le métronome : on juge la
 * régularité. Tolérance : 70 ms, ou un quart de l'écart avec la note précédente si c'est plus.
 * Après une longue pause (plus de 2,5 fois l'écart prévu), on repart sans juger.
 */
export class RhythmTracker {
  private last: { index: number; onset: number } | null = null;
  /** Secondes de partition par seconde réelle, d'après les dernières notes. */
  private rate: number | null = null;
  private counts = { onTime: 0, early: 0, late: 0 };

  /** @param expected début de chaque note, en secondes de partition ; @param speed tempo choisi / écrit */
  constructor(
    private readonly expected: readonly number[],
    private readonly speed = 1,
  ) {}

  /** Reprise (boucle, nouveau passage) : la prochaine note n'est pas jugée. */
  restart(): void {
    this.last = null;
  }

  /** Remet les compteurs à zéro (nouveau passage). */
  resetCounts(): void {
    this.counts = { onTime: 0, early: 0, late: 0 };
  }

  /** La note `index` a été attaquée à `onset` (secondes). Renvoie le verdict, ou null si non jugée. */
  hit(index: number, onset: number): { verdict: RhythmVerdict; deviationMs: number } | null {
    const prev = this.last;
    this.last = { index, onset };
    if (!prev || index <= prev.index) return null;
    const scoreGap = this.expected[index] - this.expected[prev.index];
    if (!(scoreGap > 0)) return null;
    const rate = this.rate ?? this.speed;
    const predictedGap = scoreGap / rate;
    const actualGap = onset - prev.onset;
    if (actualGap > predictedGap * 2.5 || actualGap <= 0) {
      return null; // pause, ou reprise : pas de jugement
    }
    // Le tempo de l'élève suit doucement ses notes (une note isolée ne le change pas beaucoup).
    const measured = scoreGap / actualGap;
    this.rate = this.rate === null ? measured : 0.7 * this.rate + 0.3 * measured;
    const deviation = actualGap - predictedGap;
    const tolerance = Math.max(0.07, predictedGap * 0.25);
    const verdict: RhythmVerdict = deviation < -tolerance ? "early" : deviation > tolerance ? "late" : "on";
    if (verdict === "on") this.counts.onTime++;
    else this.counts[verdict]++;
    return { verdict, deviationMs: Math.round(deviation * 1000) };
  }

  get report(): RhythmReport {
    const { onTime, early, late } = this.counts;
    const evaluated = onTime + early + late;
    return { evaluated, onTime, early, late, percent: evaluated ? Math.round((onTime / evaluated) * 100) : 100 };
  }
}

/** Phrase de bilan du rythme. */
export function rhythmSummary(r: RhythmReport): string {
  if (r.evaluated === 0) return "Rythme : pas assez de notes pour juger.";
  const parts = [r.early && `${r.early} en avance`, r.late && `${r.late} en retard`].filter(Boolean);
  return `Rythme : ${r.percent} % des notes à l'heure${parts.length ? ` (${parts.join(", ")})` : ""}.`;
}
