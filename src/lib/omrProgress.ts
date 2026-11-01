/**
 * Avancement de la reconnaissance d'un PDF par Audiveris, d'après son journal (logique pure, testée).
 * Audiveris annonce le nombre de pages (« 9 sheets in … »), puis passe chaque page par 20 étapes
 * (LOAD, BINARY … PAGE), puis exporte le MusicXML. En reprise page par page, l'application native
 * envoie « RUN n/total » avant chaque page.
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

export interface OmrProgress {
  /** 0 → 1, pour la reconnaissance seule (l'écran d'import la place entre 5 % et 90 %). */
  fraction: number;
  /** Page en cours et nombre de pages, s'ils sont connus. */
  page?: number;
  pages?: number;
  label: string;
}

export class OmrProgressTracker {
  private pages = 0;
  /** Pages traitées par l'exécution en cours d'Audiveris (toutes, ou une seule en reprise). */
  private runSheets: number[] = [];
  private run: { n: number; total: number } | null = null;
  private best = 0;
  private current: OmrProgress = { fraction: 0, label: "Démarrage d'Audiveris…" };

  get progress(): OmrProgress {
    return this.current;
  }

  /** Une ligne du journal ; renvoie l'avancement s'il a changé. */
  line(text: string): OmrProgress | null {
    const run = text.match(/^RUN (\d+)\/(\d+)/);
    if (run) {
      this.run = { n: Number(run[1]), total: Number(run[2]) };
      this.pages = this.run.total;
      return this.set(((this.run.n - 1) / this.run.total), this.run.n, `Page ${this.run.n} sur ${this.run.total} (nouvel essai, page par page)`);
    }
    const sheets = text.match(/(\d+) sheets? in /);
    if (sheets) {
      if (!this.run) this.pages = Number(sheets[1]);
      return this.set(this.best, undefined, `${this.pages} page${this.pages > 1 ? "s" : ""} à lire`);
    }
    const reaching = text.match(/Book reaching \w+ on sheets:\[([#\d]+)\]/);
    if (reaching) {
      this.runSheets = reaching[1].split("#").filter(Boolean).map(Number);
      return null;
    }
    const step = text.match(/#(\d+)\]\s+StepMonitoring\s+\d+\s+\|\s+([A-Z_]+)/);
    if (step) {
      const sheet = Number(step[1]);
      const index = OMR_STEPS.indexOf(step[2] as (typeof OMR_STEPS)[number]);
      if (index < 0) return null;
      const order = this.runSheets.length ? this.runSheets : Array.from({ length: this.pages || sheet }, (_, i) => i + 1);
      const position = Math.max(0, order.indexOf(sheet));
      const inRun = (position + (index + 1) / OMR_STEPS.length) / Math.max(1, order.length);
      const fraction = this.run ? (this.run.n - 1 + inRun) / this.run.total : inRun;
      const pages = this.pages || order.length;
      return this.set(fraction, sheet, `Page ${sheet} sur ${pages} : ${STEP_LABELS[step[2]] ?? step[2].toLowerCase()}`);
    }
    if (/Exporting sheet/.test(text)) return this.set(Math.max(this.best, this.run ? this.best : 1), undefined, "Écriture de la partition (MusicXML)…");
    return null;
  }

  private set(fraction: number, page: number | undefined, label: string): OmrProgress {
    // l'avancement ne recule jamais (pages traitées dans le désordre, reprise page par page)
    this.best = Math.min(1, Math.max(this.best, fraction));
    this.current = { fraction: this.best, label, ...(page ? { page } : {}), ...(this.pages ? { pages: this.pages } : {}) };
    return this.current;
  }
}
