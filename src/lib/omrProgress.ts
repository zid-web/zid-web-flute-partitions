/**
 * Avancement de la reconnaissance d'un PDF par Audiveris, d'après son journal (logique pure, testée).
 * L'application native traite les pages une par une, plusieurs à la fois : elle annonce le nombre
 * de pages (« PAGES 9 »), le début et la fin de chaque page (« PAGE_START 3 », « PAGE_DONE 3 ok »),
 * et transmet le journal d'Audiveris, où chaque page passe par 20 étapes (LOAD, BINARY … PAGE).
 */
export const OMR_STEPS = [
  "LOAD", "BINARY", "SCALE", "GRID", "HEADERS", "STEM_SEEDS", "BEAMS", "LEDGERS", "HEADS", "STEMS",
  "REDUCTION", "CUE_BEAMS", "TEXTS", "MEASURES", "CHORDS", "CURVES", "SYMBOLS", "LINKS", "RHYTHMS", "PAGE",
] as const;

/** Ce que fait Audiveris à chaque étape, en clair. */
const STEP_LABELS: Record<string, string> = {
  LOAD: "ouverture de la page",
  BINARY: "nettoyage de l'image",
  SCALE: "mesure des portées",
  GRID: "repérage des portées",
  HEADERS: "clés et armures",
  STEM_SEEDS: "hampes",
  BEAMS: "ligatures",
  LEDGERS: "lignes supplémentaires",
  HEADS: "têtes de notes",
  STEMS: "hampes",
  REDUCTION: "vérification des notes",
  CUE_BEAMS: "petites notes",
  TEXTS: "textes",
  MEASURES: "mesures",
  CHORDS: "accords",
  CURVES: "liaisons",
  SYMBOLS: "nuances et symboles",
  LINKS: "assemblage",
  RHYTHMS: "rythmes",
  PAGE: "fin de la page",
};

/** À partir de ce nombre de parties sur une page, c'est une partition d'orchestre (ou de chœur). */
export const ORCHESTRA_PARTS = 6;

export interface OmrProgress {
  /** 0 → 1, pour la reconnaissance seule (l'écran d'import la place entre 3 % et 88 %). */
  fraction: number;
  /** Page en cours et nombre de pages, s'ils sont connus. */
  page?: number;
  pages?: number;
  label: string;
  /** Nombre de parties d'une page d'orchestre : la reconnaissance sera longue. */
  orchestra?: number;
}

const list = (pages: number[]) =>
  pages.length === 1 ? `${pages[0]}` : `${pages.slice(0, -1).join(", ")} et ${pages[pages.length - 1]}`;

export class OmrProgressTracker {
  private pages = 0;
  /** Étape atteinte (0 → 20) de chaque page commencée ; 21 = terminée. */
  private reached = new Map<number, number>();
  private running = new Set<number>();
  private lastStep = "";
  private orchestra = 0;
  private best = 0;
  private current: OmrProgress = { fraction: 0, label: "Démarrage d'Audiveris…" };

  get progress(): OmrProgress {
    return this.current;
  }

  /** Une ligne du journal ; renvoie l'avancement s'il a changé. */
  line(text: string): OmrProgress | null {
    const total = text.match(/^PAGES (\d+)/) ?? text.match(/(\d+) sheets? in /);
    if (total) {
      if (!this.pages) this.pages = Number(total[1]);
      return this.update(`${this.pages} page${this.pages > 1 ? "s" : ""} à lire`);
    }
    const start = text.match(/^PAGE_START (\d+)/);
    if (start) {
      const n = Number(start[1]);
      this.running.add(n);
      this.reached.set(n, Math.max(this.reached.get(n) ?? 0, 0));
      return this.update();
    }
    const done = text.match(/^PAGE_DONE (\d+)/);
    if (done) {
      const n = Number(done[1]);
      this.running.delete(n);
      this.reached.set(n, OMR_STEPS.length + 1);
      return this.update();
    }
    const parts = text.match(/(\d+) parts? along/);
    if (parts && Number(parts[1]) >= ORCHESTRA_PARTS && Number(parts[1]) > this.orchestra) {
      this.orchestra = Number(parts[1]);
      return this.update();
    }
    const step = text.match(/#(\d+)\]\s+StepMonitoring\s+\d+\s+\|\s+([A-Z_]+)/);
    if (step) {
      const n = Number(step[1]);
      const index = OMR_STEPS.indexOf(step[2] as (typeof OMR_STEPS)[number]);
      if (index < 0) return null;
      this.running.add(n);
      this.reached.set(n, Math.max(this.reached.get(n) ?? 0, index + 1));
      this.lastStep = STEP_LABELS[step[2]] ?? step[2].toLowerCase();
      return this.update();
    }
    return null;
  }

  private update(label?: string): OmrProgress {
    const pages = this.pages || Math.max(1, ...this.reached.keys());
    let sum = 0;
    for (const r of this.reached.values()) sum += r / (OMR_STEPS.length + 1);
    // l'avancement ne recule jamais
    this.best = Math.min(1, Math.max(this.best, sum / pages));
    const running = [...this.running].sort((a, b) => a - b);
    const finished = [...this.reached.values()].filter((r) => r > OMR_STEPS.length).length;
    if (!label) {
      const what = this.lastStep ? ` : ${this.lastStep}` : "";
      if (running.length === 0) label = finished >= pages ? "Écriture de la partition (MusicXML)…" : `${finished} page${finished > 1 ? "s" : ""} sur ${pages} terminée${finished > 1 ? "s" : ""}`;
      else if (running.length === 1 && finished === 0) label = `Page ${running[0]} sur ${pages}${what}`;
      else label = `Page${running.length > 1 ? "s" : ""} ${list(running)} en cours (${finished} sur ${pages} terminée${finished > 1 ? "s" : ""})${what}`;
    }
    this.current = {
      fraction: this.best,
      label,
      ...(running.length ? { page: running[0] } : {}),
      ...(this.pages ? { pages: this.pages } : {}),
      ...(this.orchestra ? { orchestra: this.orchestra } : {}),
    };
    return this.current;
  }
}
