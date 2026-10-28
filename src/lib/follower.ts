import { centsOff } from "./notes";

/**
 * Suivi de partition : décide quand la note attendue a été jouée.
 * Logique pure (aucune dépendance audio / DOM) pour être testée.
 */
export interface FollowerOptions {
  /** Tolérance de justesse en cents (50 = demi-ton entier accepté de part et d'autre). */
  toleranceCents: number;
  /** Durée pendant laquelle la note doit tenir avant d'être validée. */
  holdMs: number;
  /** Accepte la bonne note à l'octave près (débutants, octave qui « saute »). */
  octaveTolerant: boolean;
}

export const DEFAULT_FOLLOWER_OPTIONS: FollowerOptions = {
  toleranceCents: 45,
  holdMs: 90,
  octaveTolerant: false,
};

/** Une détection audio : hauteur MIDI fractionnaire, ou null pour un silence. */
export interface PitchFrame {
  midi: number | null;
  timeMs: number;
  /** Volume (RMS) : sert à repérer le coup de langue entre deux notes identiques. */
  level?: number;
}

/**
 * Coup de langue : entre deux notes identiques, le son ne s'arrête pas complètement (souffle,
 * résonance de la pièce) mais le volume chute nettement. En dessous de cette fraction du volume
 * de la note tenue, on considère que la note suivante est attaquée.
 */
export const REARTICULATION_RATIO = 0.4;
/** Après la chute, le volume doit remonter (vraie attaque) et pas seulement s'éteindre (résonance). */
export const REATTACK_RISE = 1.8;

export type FollowerEvent =
  | { type: "hit"; index: number }
  | { type: "wrong"; index: number; playedMidi: number }
  | { type: "finished" };

export class ScoreFollower {
  private index = 0;
  private candidateSince: number | null = null;
  private wrongSince: number | null = null;
  private wrongReported = false;
  /**
   * Hauteur de la note qui vient d'être validée, tant qu'elle sonne encore :
   * sa fin n'est pas une fausse note, et si la suivante est identique il faut une nouvelle attaque.
   */
  private sustainMidi: number | null = null;
  /** Volume maximal de la note tenue (pour repérer le coup de langue). */
  private sustainPeak = 0;
  /** Après un coup de langue : volume le plus bas atteint, en attendant que le son remonte. */
  private dipFloor: number | null = null;

  constructor(
    private readonly expected: readonly number[],
    private options: FollowerOptions = DEFAULT_FOLLOWER_OPTIONS,
  ) {}

  get position(): number {
    return this.index;
  }

  get done(): boolean {
    return this.index >= this.expected.length;
  }

  setOptions(options: FollowerOptions): void {
    this.options = options;
  }

  reset(index = 0): void {
    this.index = index;
    this.candidateSince = null;
    this.wrongSince = null;
    this.wrongReported = false;
    this.sustainMidi = null;
    this.dipFloor = null;
  }

  matches(playedMidi: number, expectedMidi: number): boolean {
    const { toleranceCents, octaveTolerant } = this.options;
    if (Math.abs(centsOff(playedMidi, expectedMidi)) <= toleranceCents) return true;
    if (!octaveTolerant) return false;
    const folded = ((centsOff(playedMidi, expectedMidi) % 1200) + 1200) % 1200;
    return folded <= toleranceCents || folded >= 1200 - toleranceCents;
  }

  push(frame: PitchFrame): FollowerEvent[] {
    if (this.done) return [];
    const target = this.expected[this.index];

    if (frame.midi === null) {
      this.sustainMidi = null;
      this.dipFloor = null;
      this.candidateSince = null;
      this.wrongSince = null;
      this.wrongReported = false;
      return [];
    }

    if (this.sustainMidi !== null) {
      const level = frame.level;
      if (level !== undefined) this.sustainPeak = Math.max(this.sustainPeak, level);
      const dipped = level !== undefined && level < this.sustainPeak * REARTICULATION_RATIO;
      if (!dipped && this.matches(frame.midi, this.sustainMidi)) return [];
      this.sustainMidi = null;
      this.dipFloor = dipped ? (level as number) : null;
    }

    if (this.dipFloor !== null && frame.level !== undefined) {
      if (frame.level < this.dipFloor * REATTACK_RISE) {
        this.dipFloor = Math.min(this.dipFloor, frame.level);
        this.candidateSince = null;
        return []; // le son s'éteint encore : pas de nouvelle attaque
      }
      this.dipFloor = null;
    }

    if (this.matches(frame.midi, target)) {
      this.wrongSince = null;
      this.wrongReported = false;
      this.candidateSince ??= frame.timeMs;
      if (frame.timeMs - this.candidateSince < this.options.holdMs) return [];

      const hitIndex = this.index;
      this.index += 1;
      this.candidateSince = null;
      this.sustainMidi = target;
      this.sustainPeak = frame.level ?? 0;
      const events: FollowerEvent[] = [{ type: "hit", index: hitIndex }];
      if (this.done) events.push({ type: "finished" });
      return events;
    }

    this.candidateSince = null;
    this.wrongSince ??= frame.timeMs;
    if (!this.wrongReported && frame.timeMs - this.wrongSince >= this.options.holdMs * 2) {
      this.wrongReported = true;
      return [{ type: "wrong", index: this.index, playedMidi: frame.midi }];
    }
    return [];
  }
}

/** Étoiles de fin de morceau selon le nombre de fausses notes. */
export function starsFor(noteCount: number, wrongCount: number): 1 | 2 | 3 {
  if (noteCount === 0) return 3;
  const ratio = wrongCount / noteCount;
  if (ratio <= 0.05) return 3;
  if (ratio <= 0.2) return 2;
  return 1;
}
