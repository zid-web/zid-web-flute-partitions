import { OpenSheetMusicDisplay, type GraphicalNote, type Note } from "opensheetmusicdisplay";
import { measureTimeline, type MeasureTimeline } from "./accompaniment";
import { DEFAULT_QPM, tempoMap } from "./tempo";

/** Une note à jouer, dans l'ordre de la partition (silences et liaisons exclus). */
export interface ScoreStep {
  midi: number;
  /** Durée en noires. */
  beats: number;
  /** Position du curseur OSMD correspondante. */
  cursorIndex: number;
  /** Nombre de noires depuis le début. */
  startBeat: number;
  /** Début et durée en secondes au tempo écrit (changements de tempo compris), pour le mode Écouter. */
  startSec: number;
  seconds: number;
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
  /** Tempo écrit au début du morceau, en noires par minute (120 sans indication, comme MuseScore). */
  tempo = DEFAULT_QPM;
  private tempos: number[] = [];
  private timeline: MeasureTimeline = { startSec: [], secPerQuarter: [] };
  /**
   * Toutes les positions où une note est jouée, toutes parties comprises (votre flûte et la
   * 2ᵉ flûte affichée) : le curseur du mode Écouter les parcourt, même pendant vos silences.
   */
  positions: { cursorIndex: number; startSec: number }[] = [];
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
    this.tempos = tempoMap(xml);
    this.timeline = measureTimeline(xml);
    this.tempo = this.tempos[0] ?? DEFAULT_QPM;
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
    this.positions = [];
    this.gnotesByCursor.clear();
    // Seule la première partie (la vôtre) est suivie au micro et colorée ; les autres sont affichées.
    const mine = this.osmd.Sheet?.Instruments[0];
    const isMine = (n: Note) => !mine || n.ParentStaffEntry?.ParentStaff?.ParentInstrument === mine;
    let i = 0;
    while (!cursor.Iterator.EndReached) {
      const notes = cursor.NotesUnderCursor();
      // Instant de la note : début de sa mesure dans le calendrier commun au son (measureTimeline),
      // plus sa position exacte dans la mesure. Pas de somme de durées : aucune dérive possible,
      // même au piano où plusieurs voix se chevauchent.
      const it = cursor.Iterator;
      const m = it.CurrentMeasureIndex;
      const secPerBeat = this.timeline.secPerQuarter[m] ?? 60 / (this.tempos[m] ?? this.tempo);
      const inMeasure = (it.CurrentSourceTimestamp.RealValue - (it.CurrentMeasure?.AbsoluteTimestamp.RealValue ?? 0)) * 4;
      const beat = it.CurrentSourceTimestamp.RealValue * 4;
      const sec = (this.timeline.startSec[m] ?? 0) + inMeasure * secPerBeat;
      // Partition de flûte = monodique : on prend la note la plus aiguë s'il y a un accord.
      if (notes.some((n) => !n.isRest() && !n.IsGraceNote && !isTieContinuation(n))) {
        this.positions.push({ cursorIndex: i, startSec: sec });
      }
      const playable = notes.filter((n) => isMine(n) && !n.isRest() && !n.IsGraceNote && !isTieContinuation(n));
      if (playable.length > 0) {
        const top = playable.reduce((a, b) => (noteToMidi(b) > noteToMidi(a) ? b : a));
        let beats = top.Length.RealValue * 4;
        // Ajoute la durée des notes liées qui suivent.
        const tie = top.NoteTie;
        if (tie) beats = tie.Notes.reduce((s, n) => s + n.Length.RealValue * 4, 0);
        this.steps.push({
          midi: noteToMidi(top),
          beats,
          cursorIndex: i,
          startBeat: beat,
          startSec: sec,
          seconds: beats * secPerBeat,
        });
        this.gnotesByCursor.set(i, cursor.GNotesUnderCursor().filter((g) => isMine(g.sourceNote)));
      }
      cursor.next();
      i++;
    }
    cursor.reset();
    this.cursorIndex = 0;
  }

  /** Place le curseur sur la n-ième note à jouer. */
  goToStep(step: number): void {
    const target = this.steps[step]?.cursorIndex;
    if (target === undefined) {
      this.osmd.cursor.hide();
      return;
    }
    this.goToCursor(target);
    this.color(step, COLORS.current);
  }

  /** Place le curseur sur une position de la partition (voir `positions`), sans colorer. */
  goToCursor(target: number): void {
    const cursor = this.osmd.cursor;
    if (target < this.cursorIndex) {
      cursor.reset();
      this.cursorIndex = 0;
    }
    while (this.cursorIndex < target) {
      cursor.next();
      this.cursorIndex++;
    }
    cursor.show();
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
