import { OpenSheetMusicDisplay, type GraphicalNote, type Note } from "opensheetmusicdisplay";

/** Une note à jouer, dans l'ordre de la partition (silences et liaisons exclus). */
export interface ScoreStep {
  midi: number;
  /** Durée en noires. */
  beats: number;
  /** Position du curseur OSMD correspondante. */
  cursorIndex: number;
  /** Nombre de noires depuis le début (pour le mode Écouter). */
  startBeat: number;
}

export const COLORS = {
  current: "#f59e0b",
  hit: "#10b981",
  wrong: "#ef4444",
  idle: "#000000",
} as const;

/** NoteEnum OSMD : Do=0, Ré=2, Mi=4, Fa=5, Sol=7, La=9, Si=11 ; octave OSMD 1 = octave MusicXML 4. */
function noteToMidi(note: Note): number {
  const p = note.Pitch;
  return (p.Octave + 4) * 12 + p.FundamentalNote + p.AccidentalHalfTones;
}

function isTieContinuation(note: Note): boolean {
  const tie = note.NoteTie;
  return Boolean(tie && tie.StartNote !== note);
}

/**
 * Enveloppe OSMD : rendu de la partition, curseur et coloration des notes.
 * Le curseur parcourt chaque position rythmique ; on ne garde que celles où
 * une nouvelle note doit être attaquée (pas les silences ni les notes liées).
 */
export class ScoreController {
  readonly osmd: OpenSheetMusicDisplay;
  steps: ScoreStep[] = [];
  private gnotesByCursor = new Map<number, GraphicalNote[]>();
  private cursorIndex = 0;

  constructor(container: HTMLElement) {
    this.osmd = new OpenSheetMusicDisplay(container, {
      autoResize: true,
      backend: "svg",
      drawTitle: true,
      drawComposer: true,
      drawPartNames: false,
      followCursor: true,
      cursorsOptions: [{ type: 0, color: "#6366f1", alpha: 0.35, follow: true }],
    });
  }

  async load(xml: string): Promise<void> {
    await this.osmd.load(xml);
    this.osmd.render();
    this.indexSteps();
    this.osmd.cursor.show();
    this.goToStep(0);
  }

  private indexSteps(): void {
    const cursor = this.osmd.cursor;
    cursor.reset();
    this.steps = [];
    this.gnotesByCursor.clear();
    let i = 0;
    let beat = 0;
    while (!cursor.Iterator.EndReached) {
      const notes = cursor.NotesUnderCursor();
      // Partition de flûte = monodique : on prend la note la plus aiguë s'il y a un accord.
      const playable = notes.filter((n) => !n.isRest() && !n.IsGraceNote && !isTieContinuation(n));
      const shortest = notes.reduce(
        (min, n) => Math.min(min, n.Length.RealValue * 4),
        Number.POSITIVE_INFINITY,
      );
      if (playable.length > 0) {
        const top = playable.reduce((a, b) => (noteToMidi(b) > noteToMidi(a) ? b : a));
        let beats = top.Length.RealValue * 4;
        // Ajoute la durée des notes liées qui suivent.
        const tie = top.NoteTie;
        if (tie) beats = tie.Notes.reduce((s, n) => s + n.Length.RealValue * 4, 0);
        this.steps.push({ midi: noteToMidi(top), beats, cursorIndex: i, startBeat: beat });
        this.gnotesByCursor.set(i, cursor.GNotesUnderCursor());
      }
      beat += Number.isFinite(shortest) ? shortest : 0;
      cursor.next();
      i++;
    }
    cursor.reset();
    this.cursorIndex = 0;
  }

  /** Place le curseur sur la n-ième note à jouer. */
  goToStep(step: number): void {
    const target = this.steps[step]?.cursorIndex;
    const cursor = this.osmd.cursor;
    if (target === undefined) {
      cursor.hide();
      return;
    }
    if (target < this.cursorIndex) {
      cursor.reset();
      this.cursorIndex = 0;
    }
    while (this.cursorIndex < target) {
      cursor.next();
      this.cursorIndex++;
    }
    cursor.show();
    this.color(step, COLORS.current);
  }

  color(step: number, color: string): void {
    const s = this.steps[step];
    if (!s) return;
    for (const g of this.gnotesByCursor.get(s.cursorIndex) ?? []) {
      try {
        g.setColor(color, { applyToNoteheads: true, applyToStem: true, applyToFlag: true, applyToBeams: false });
      } catch {
        // Note sans élément SVG (ex. note cachée) : rien à colorer.
      }
    }
  }

  resetColors(): void {
    this.steps.forEach((_, i) => this.color(i, COLORS.idle));
  }

  dispose(): void {
    this.osmd.clear();
  }
}
