/**
 * Marge après le début de la note attendue (secondes de partition) : couvre le temps de
 * reconnaissance d'une note jouée à l'heure (attaque + validation ≈ 0,15 s).
 */
export const WAIT_GRACE = 0.2;

/** Nombre d'attaques gardées pour mesurer le tempo. */
const HISTORY = 4;

/** Écart (secondes) entre attaque mesurée et prévue en dessous duquel le recalage est adouci. */
export const SMOOTH_WITHIN = 0.08;

/**
 * Accompagnateur qui suit le flûtiste (piano, 2ᵉ flûte) — logique pure, sans audio, testée.
 *
 * Au lieu d'attendre que chaque note de la flûte soit reconnue (le piano arriverait toujours en
 * retard du temps de reconnaissance), l'accompagnement joue en continu, en anticipant, au tempo
 * mesuré sur le jeu du flûtiste :
 * - correspondance « temps de la partition » ↔ « heure audio » : une ancre et une vitesse ;
 * - à chaque note reconnue, l'ancre est recalée sur l'instant réel de l'attaque et la vitesse
 *   s'ajuste (moyenne lissée, valeurs aberrantes ignorées : une note tenue plus longtemps ne
 *   fait pas s'effondrer le tempo) ;
 * - si la flûte ne vient pas, l'accompagnement l'attend : il joue l'accord qui tombe avec la
 *   note attendue (à l'heure prévue, pour être ensemble), puis s'arrête juste après, le temps
 *   que la note soit reconnue (`WAIT_GRACE`), jusqu'à ce qu'elle soit jouée.
 * Toutes les heures sont celles où le son est entendu (secondes, horloge audio).
 */
export class Accompanist {
  private anchorScore = 0;
  private anchorAudio = 0;
  /** Secondes de partition par seconde réelle (1 = tempo écrit). */
  private rate: number;
  /** Prochaine note de la flûte attendue (indice dans `flute`). */
  private expected = 0;
  /** Partie de la partition déjà confiée au son, jusqu'à ce temps (exclu). */
  private scheduledTo = 0;
  /** Dernières attaques (après recalage), pour mesurer le tempo sur plusieurs notes. */
  private history: { score: number; audio: number }[] = [];

  /**
   * @param flute début de chaque note de la flûte, en secondes de partition (croissant)
   * @param speed tempo choisi / tempo écrit
   */
  constructor(
    private readonly flute: readonly number[],
    private readonly speed: number,
  ) {
    this.rate = speed;
  }

  /** Démarre l'accompagnement : le temps `fromScore` de la partition sonne à l'heure `audio`. */
  start(fromScore: number, audio: number, expected = 0): void {
    this.anchorScore = fromScore;
    this.anchorAudio = audio;
    this.rate = this.speed;
    this.expected = expected;
    this.scheduledTo = fromScore;
    this.history = [];
  }

  /** Vitesse actuelle (1 = tempo écrit), pour l'affichage et les tests. */
  get tempoRatio(): number {
    return this.rate;
  }

  /** Heure audio à laquelle doit sonner le temps `score` de la partition. */
  toAudio(score: number): number {
    return this.anchorAudio + (score - this.anchorScore) / this.rate;
  }

  /** Temps de la partition qui sonne à l'heure `audio`. */
  toScore(audio: number): number {
    return this.anchorScore + (audio - this.anchorAudio) * this.rate;
  }

  /** La note `index` de la flûte a commencé à sonner à l'heure `audio`. */
  hit(index: number, audio: number): void {
    const score = this.flute[index];
    if (score === undefined) return;
    const prev = this.history[this.history.length - 1];
    // Tempo mesuré depuis la plus ancienne des dernières attaques (sur plusieurs notes, l'imprécision
    // de chaque attaque compte moins), tant que le jeu y est régulier.
    for (const old of this.history) {
      if (score - old.score < 0.2 || audio <= old.audio) continue;
      const measured = (score - old.score) / (audio - old.audio);
      // Une note tenue (ou écourtée) bien au-delà du rythme n'est pas un changement de tempo.
      if (measured > this.rate / 1.8 && measured < this.rate * 1.8) {
        this.rate = Math.min(this.speed * 2, Math.max(this.speed / 2, 0.4 * this.rate + 0.6 * measured));
        break;
      }
    }
    // Recalage : l'instant mesuré d'une attaque est imprécis de quelques centièmes ; quand il est
    // proche de la prévision, on n'en garde que la moitié (moins de flottement). Un vrai écart
    // (flûte en avance ou en retard) est suivi entièrement.
    const predicted = this.toAudio(score);
    const gap = audio - predicted;
    this.anchorScore = score;
    this.anchorAudio = prev && Math.abs(gap) < SMOOTH_WITHIN ? predicted + gap / 2 : audio;
    this.expected = Math.max(this.expected, index + 1);
    this.history = [...this.history, { score, audio: this.anchorAudio }].slice(-HISTORY);
  }

  /** Jusqu'où l'accompagnement peut aller sans la flûte : un peu après le début de la note attendue. */
  get limit(): number {
    const at = this.flute[this.expected];
    if (at === undefined) return Infinity; // la flûte a fini : le piano termine seul
    const next = this.flute[this.expected + 1] ?? Infinity;
    return at + Math.min(WAIT_GRACE, 0.9 * (next - at));
  }

  /**
   * Partie de la partition à programmer maintenant (`now` = heure audio entendue), avec
   * `lookahead` secondes d'avance : [from, to[ en temps de partition, ou null s'il n'y a rien.
   */
  advance(now: number, lookahead: number): { from: number; to: number } | null {
    const to = Math.min(this.toScore(now + lookahead), this.limit);
    if (to <= this.scheduledTo + 1e-9) return null;
    const from = this.scheduledTo;
    this.scheduledTo = to;
    return { from, to };
  }
}
