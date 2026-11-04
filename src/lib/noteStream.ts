/**
 * Programmation au fil de l'eau (logique pure, testée) : au lieu de confier toutes les notes d'un
 * morceau à la carte son d'un coup (un orchestre entier, comme le Boléro, en compte des dizaines
 * de milliers : l'application se figeait de longues secondes et le son ne partait pas), on ne
 * programme que les quelques secondes à venir, en continu.
 */
export class NoteStream<T> {
  private next = 0;

  /** `items` triés par heure ; `timeOf` donne l'heure audio d'un élément. */
  constructor(
    private readonly items: readonly T[],
    private readonly timeOf: (item: T) => number,
  ) {}

  /** Éléments pas encore programmés qui commencent avant `horizon` (dans l'ordre). */
  take(horizon: number): T[] {
    const out: T[] = [];
    while (this.next < this.items.length && this.timeOf(this.items[this.next]) < horizon) out.push(this.items[this.next++]);
    return out;
  }

  get done(): boolean {
    return this.next >= this.items.length;
  }
}

/** Secondes de musique programmées à l'avance (le reste suit, par petits morceaux). */
export const SCHEDULE_AHEAD = 4;
/** Intervalle entre deux programmations (ms) ; même ralenti en arrière-plan, l'avance suffit. */
export const SCHEDULE_EVERY_MS = 250;
