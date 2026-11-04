import { useCallback, useEffect, useRef, useState } from "react";
import { Accompanist } from "../lib/accompanist";
import { mergeMarks, readExpressiveMarks, timeWarp } from "../lib/expressive";
import { IntonationTracker, intonationSummary, type IntonationReport } from "../lib/intonation";
import {
  countIn,
  nextLoopTempo,
  RhythmTracker,
  rhythmSummary,
  stepRange,
  type RhythmReport,
  type RhythmVerdict,
} from "../lib/practice";
import {
  expandOrnament,
  melodyNotes,
  withPartnerFlutes,
  pianoNotes,
  splitAccompaniment,
  type MelodyNote,
  type PianoNote,
} from "../lib/accompaniment";
import { LEVEL_LABELS, loadAccompanimentXml, loadScoreXml, type CatalogEntry } from "../lib/catalog";
import { DEFAULT_FOLLOWER_OPTIONS, ScoreFollower, starsFor, type FollowerEvent } from "../lib/follower";
import { centsOff, midiToName } from "../lib/notes";
import { FLUTE_HIGH, FLUTE_LOW } from "../lib/fluteRange";
import { MicPitchSource } from "../lib/pitch";
import { recordResult, type PieceProgress } from "../lib/progress";
import { COLORS, ScoreController } from "../lib/score";
import { applyNoteEdit, canEditNote, type NoteEdit } from "../lib/noteEdit";
import { updateUserScoreXml } from "../lib/userScores";
import { isMyFluteEnabled, isMyFluteOnly, listTakes } from "../lib/myFlute";
import { PianoSampler } from "../lib/piano";
import { SampledFlute, type FlutePlayer } from "../lib/sampler";
import { FluteSynth } from "../lib/synth";
import { Fingering } from "./Fingering";
import { NoteStream, SCHEDULE_AHEAD, SCHEDULE_EVERY_MS } from "../lib/noteStream";

interface Props {
  entry: CatalogEntry;
  bestStars: number;
  onBack: () => void;
  onProgress: (p: Record<string, PieceProgress>) => void;
  /** Mouvements de la même œuvre, dans l'ordre (la partition seule s'il n'y en a pas d'autres). */
  movements?: CatalogEntry[];
  /** Ouvre un autre mouvement ; `listen` : l'écoute y démarre toute seule (enchaînement). */
  onOpenMovement?: (entry: CatalogEntry, listen: boolean) => void;
  /** Démarrer l'écoute dès que la partition est prête (mouvement enchaîné). */
  autoListen?: boolean;
}

interface AudioBundle {
  ctx: AudioContext;
  flute: Promise<FlutePlayer>;
  /** false : simple synthétiseur (partition pour piano seul), la vraie flûte n'est pas chargée. */
  realFlute: boolean;
  piano?: Promise<PianoSampler | null>;
}

/**
 * Sons passés d'un mouvement au suivant : le contexte audio, déjà autorisé par un geste de
 * l'utilisateur, et les enregistrements déjà chargés (sinon Safari bloquerait l'enchaînement).
 */
let handoff: AudioBundle | null = null;

const CHAIN_KEY = "flute-partitions:chain-movements";
const COUNT_IN_KEY = "flute-partitions:decompte";
function loadCountIn(): boolean {
  try {
    return localStorage.getItem(COUNT_IN_KEY) !== "off";
  } catch {
    return true;
  }
}

const RHYTHM_LABELS: Record<RhythmVerdict, string> = { early: "⏩ en avance", on: "✓ à l'heure", late: "⏪ en retard" };

function loadChain(): boolean {
  try {
    return localStorage.getItem(CHAIN_KEY) !== "off";
  } catch {
    return true;
  }
}

type Mode = "idle" | "mic" | "listen" | "finished";

/** Avance de programmation de l'accompagnement (secondes) : assez pour ne jamais manquer une note. */
const LOOKAHEAD = 0.15;
/** Retard du micro et de l'analyse sur le son réel de la flûte (secondes). */
const MIC_DELAY = 0.03;

/** Note sélectionnée pour la corriger. */
const EDIT_COLOR = "#6366f1";

const PRAISE = ["Bravo !", "Super !", "Magnifique !", "Quelle oreille !", "Continuez !", "Parfait !"];

export function Player({ entry, bestStars, onBack, onProgress, movements = [entry], onOpenMovement, autoListen }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scoreRef = useRef<ScoreController | null>(null);
  const followerRef = useRef<ScoreFollower | null>(null);
  const micRef = useRef<MicPitchSource | null>(null);
  const synthRef = useRef<FlutePlayer | null>(null);
  // Sons, chargés au premier « Écouter » ou « Jouer » : vraie flûte (le synthétiseur ne sert que si
  // elle ne peut pas être chargée) et vrai piano pour l'accompagnement, sur un même contexte audio.
  const audioRef = useRef<AudioBundle | null>(null);
  // Vrai quand on passe à un autre mouvement : les sons lui sont transmis au lieu d'être fermés.
  const handingOffRef = useRef(false);
  const movementIndex = Math.max(0, movements.findIndex((m) => m.id === entry.id));
  const nextMovement = movements[movementIndex + 1] ?? null;
  const [chain, setChain] = useState(loadChain);
  const [upcoming, setUpcoming] = useState<CatalogEntry | null>(null);
  const pianoRef = useRef<PianoSampler | null>(null);
  const pianoNotesRef = useRef<PianoNote[]>([]);
  // 2ᵉ flûte d'un duo : jouée par l'application (même son de flûte), pendant que vous jouez la 1ʳᵉ.
  const flute2NotesRef = useRef<PianoNote[]>([]);
  // Interprétation de la mélodie (nuances, articulations, liaisons, ornements), jouée par « Écouter » :
  // une entrée par note de la partition.
  const melodyRef = useRef<MelodyNote[]>([]);
  const pianoOnly = entry.kind === "piano";
  const timersRef = useRef<number[]>([]);
  // Boucle d'affichage du mode Écouter (synchronisée sur l'horloge audio).
  const rafRef = useRef(0);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [step, setStep] = useState(0);
  const [total, setTotal] = useState(0);
  const [heard, setHeard] = useState<number | null>(null);
  const [wrong, setWrong] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [praise, setPraise] = useState<string | null>(null);
  const [stars, setStars] = useState<number | null>(null);
  // Tempo choisi (noires par minute) ; au chargement, celui écrit sur la partition.
  const [tempo, setTempo] = useState(120);
  const [writtenTempo, setWrittenTempo] = useState(120);
  const [octaveTolerant, setOctaveTolerant] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [myFluteSound, setMyFluteSound] = useState(false);
  // Partie de piano : accompagnement (flûte + piano) ou partition pour piano seul.
  const [hasPiano, setHasPiano] = useState(false);
  const [pianoOn, setPianoOn] = useState(true);
  const [hasFlute2, setHasFlute2] = useState(false);
  const [flute2On, setFlute2On] = useState(true);

  // Outils de travail : décompte, boucle sur un passage (tempo progressif), rythme.
  const [countInOn, setCountInOn] = useState(loadCountIn);
  const [loopOn, setLoopOn] = useState(false);
  const [loopFrom, setLoopFrom] = useState(1);
  const [loopTo, setLoopTo] = useState(4);
  const [progressive, setProgressive] = useState(true);
  const [targetTempo, setTargetTempo] = useState(120);
  const [measureCount, setMeasureCount] = useState(1);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [rhythmFlash, setRhythmFlash] = useState<RhythmVerdict | null>(null);
  const [finalRhythm, setFinalRhythm] = useState<RhythmReport | null>(null);
  const [passInfo, setPassInfo] = useState<string | null>(null);
  /** Réglages lus pendant le jeu (le micro et les minuteries gardent les mêmes fonctions). */
  const practiceRef = useRef({ countInOn, loopOn, loopFrom, loopTo, progressive, targetTempo, tempo: 120 });
  /** Passage joué : première et dernière note (tout le morceau hors boucle). */
  const rangeRef = useRef({ first: 0, last: 0 });
  /** Pendant le décompte (et entre deux passages), le micro est ignoré. */
  const countingRef = useRef(false);
  const rhythmRef = useRef<RhythmTracker | null>(null);
  const intonationRef = useRef(new IntonationTracker());
  const [finalIntonation, setFinalIntonation] = useState<IntonationReport | null>(null);
  /**
   * Mode Écouter : points d'orgue et rit./rall./a tempo de la partition (et de l'accompagnement).
   * `warp` donne l'instant joué d'un instant de la partition ; notes de l'accompagnement déjà placées.
   */
  const warpRef = useRef<(sec: number) => number>((s) => s);
  const warpedRef = useRef<{ piano: PianoNote[]; flute2: PianoNote[] }>({ piano: [], flute2: [] });
  const passRef = useRef({ n: 0, wrong: 0 });

  // Correction de notes (partitions importées) : partition chargée, accompagnement affiché, annulations.
  const xmlRef = useRef<string | null>(null);
  const displayAccompRef = useRef<string | null>(null);
  const undoRef = useRef<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [editStep, setEditStep] = useState<number | null>(null);
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  /** Changée en quittant la correction : la partition est rechargée (sons, suivi, tempo). */
  const [revision, setRevision] = useState(0);
  const canEdit = entry.origin === "import" && !pianoOnly;

  // Zoom et mode pupitre pour utilisation en local sur ordinateur
  const [zoom, setZoom] = useState(1.0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const applyZoom = useCallback((next: number) => {
    const clamped = Math.min(2.0, Math.max(0.6, Math.round(next * 10) / 10));
    setZoom(clamped);
    scoreRef.current?.setZoom(clamped);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        applyZoom(zoom + 0.15);
      } else if (e.key === "-") {
        e.preventDefault();
        applyZoom(zoom - 0.15);
      } else if (e.key === "0") {
        e.preventDefault();
        applyZoom(1.0);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [zoom, applyZoom, toggleFullscreen]);

  practiceRef.current = { countInOn, loopOn, loopFrom, loopTo, progressive, targetTempo, tempo };
  const listenStepRef = useRef(0);
  const modeRef = useRef<Mode>("idle");
  modeRef.current = mode;
  /**
   * Accompagnement pendant que vous jouez (piano, 2ᵉ flûte) : il joue en continu, en avance de
   * quelques centièmes, au tempo mesuré sur votre jeu ; chacune de vos attaques le recale, et il
   * vous attend si vous tenez une note (voir `Accompanist`). Programmation toutes les 25 ms.
   */
  const accompanistRef = useRef<{ acc: Accompanist; started: boolean; timer: number } | null>(null);
  const stopAccompanist = useCallback(() => {
    if (accompanistRef.current) clearInterval(accompanistRef.current.timer);
    accompanistRef.current = null;
  }, []);

  const expectedMidi = scoreRef.current?.steps[step]?.midi ?? null;

  // Chargement et rendu de la partition.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const controller = new ScoreController(el);
    scoreRef.current = controller;
    let cancelled = false;
    setLoading(true);
    loadScoreXml(entry)
      .then(async (xml) => {
        xmlRef.current = xml;
        // Parties jouées par l'application : toute la partition (piano seul), ou l'accompagnement gardé
        // à l'import ou publié avec le morceau (piano et/ou 2ᵉ flûte).
        melodyRef.current = entry.kind === "piano" ? [] : melodyNotes(xml);
        let accompanimentXml: string | null = null;
        if (entry.kind === "piano") {
          pianoNotesRef.current = pianoNotes(xml);
          flute2NotesRef.current = [];
        } else {
          accompanimentXml = await loadAccompanimentXml(entry).catch(() => null);
          const parts = accompanimentXml ? splitAccompaniment(accompanimentXml) : { piano: [], flute: [] };
          pianoNotesRef.current = parts.piano;
          flute2NotesRef.current = parts.flute;
        }
        // Points d'orgue et rit./a tempo (mode Écouter) : votre partie et l'accompagnement.
        const marks = mergeMarks(readExpressiveMarks(xml), ...(accompanimentXml ? [readExpressiveMarks(accompanimentXml)] : []));
        const warp = timeWarp(marks);
        const place = (n: PianoNote): PianoNote => ({ ...n, startSec: warp(n.startSec), seconds: warp(n.startSec + n.seconds) - warp(n.startSec) });
        warpRef.current = warp;
        // triées par début : l'écoute les programme au fil de l'eau (NoteStream)
        // (notes sans heure valable écartées : une seule bloquerait toute la suite)
        const byStart = (a: PianoNote, b: PianoNote) => a.startSec - b.startSec;
        const valid = (n: PianoNote) => Number.isFinite(n.startSec) && Number.isFinite(n.seconds) && n.seconds >= 0;
        warpedRef.current = {
          piano: pianoNotesRef.current.map(place).filter(valid).sort(byStart),
          flute2: flute2NotesRef.current.map(place).filter(valid).sort(byStart),
        };
        if (!cancelled) {
          setHasPiano(pianoNotesRef.current.length > 0);
          setHasFlute2(flute2NotesRef.current.length > 0);
        }
        // Partition affichée : votre partie, plus la 2ᵉ flûte s'il y en a une (notes et curseur visibles
        // pendant qu'elle joue). Le micro et les couleurs ne suivent que votre partie, la première.
        displayAccompRef.current = accompanimentXml; // déjà chargé plus haut (une seule lecture)
        const display = entry.kind === "piano" ? xml : withPartnerFlutes(xml, displayAccompRef.current);
        return controller.load(display);
      })
      .then(() => {
        if (cancelled) return;
        followerRef.current = new ScoreFollower(
          controller.steps.map((s) => s.midi),
          DEFAULT_FOLLOWER_OPTIONS,
        );
        setTotal(controller.steps.length);
        const written = Math.round(controller.tempo);
        setWrittenTempo(written);
        setTempo(written);
        setTargetTempo(written);
        const measures = controller.measureCount;
        setMeasureCount(measures);
        setLoopFrom(1);
        setLoopTo(Math.min(4, measures));
        setLoading(false);
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
      micRef.current?.stop();
      if (handingOffRef.current && audioRef.current) {
        synthRef.current?.stop();
        pianoRef.current?.stop();
        handoff = audioRef.current;
      } else {
        void audioRef.current?.ctx.close().catch(() => {});
        // rechargement après une correction : de nouveaux sons seront préparés
        audioRef.current = null;
        synthRef.current = null;
        pianoRef.current = null;
      }
      timersRef.current.forEach(clearTimeout);
      cancelAnimationFrame(rafRef.current);
      if (accompanistRef.current) clearInterval(accompanistRef.current.timer);
      controller.dispose();
    };
  }, [entry, revision]);

  useEffect(() => {
    followerRef.current?.setOptions({ ...DEFAULT_FOLLOWER_OPTIONS, octaveTolerant });
  }, [octaveTolerant]);

  const finish = useCallback(
    (wrongCount: number) => {
      const s = starsFor(total, wrongCount);
      setStars(s);
      setFinalRhythm(rhythmRef.current?.report ?? null);
      setFinalIntonation(intonationRef.current.report);
      setMode("finished");
      micRef.current?.stop();
      micRef.current = null;
      onProgress(recordResult(entry.id, s));
    },
    [entry.id, onProgress, total],
  );

  const wrongRef = useRef(0);
  const handleEvents = useCallback(
    (events: FollowerEvent[]) => {
      const score = scoreRef.current;
      if (!score) return;
      for (const ev of events) {
        if (ev.type === "hit") {
          if (practiceRef.current.loopOn && ev.index === rangeRef.current.last) {
            score.color(ev.index, COLORS.hit);
            setStep(ev.index + 1);
            passDoneRef.current();
            continue;
          }
          score.color(ev.index, COLORS.hit);
          score.goToStep(ev.index + 1);
          setStep(ev.index + 1);
          setStreak((s) => {
            const n = s + 1;
            setBestStreak((b) => Math.max(b, n));
            if (n > 0 && n % 8 === 0) setPraise(PRAISE[Math.floor(Math.random() * PRAISE.length)]);
            return n;
          });
        } else if (ev.type === "wrong") {
          wrongRef.current += 1;
          passRef.current.wrong += 1;
          setWrong(wrongRef.current);
          setStreak(0);
          score.color(ev.index, COLORS.wrong);
          window.setTimeout(() => {
            if (followerRef.current?.position === ev.index) score.color(ev.index, COLORS.current);
          }, 450);
        } else if (ev.type === "finished") {
          if (practiceRef.current.loopOn) continue; // en boucle : le passage recommence
          finish(wrongRef.current);
        }
      }
    },
    [finish],
  );

  useEffect(() => {
    if (!rhythmFlash) return;
    const t = window.setTimeout(() => setRhythmFlash(null), 900);
    return () => clearTimeout(t);
  }, [rhythmFlash]);

  useEffect(() => {
    if (!praise) return;
    const t = window.setTimeout(() => setPraise(null), 1400);
    return () => clearTimeout(t);
  }, [praise]);

  const restart = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
    stopAccompanist();
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    cancelAnimationFrame(rafRef.current);
    synthRef.current?.stop();
    pianoRef.current?.stop();
    setUpcoming(null);
    const score = scoreRef.current;
    score?.resetColors();
    score?.goToStep(0);
    followerRef.current?.reset();
    wrongRef.current = 0;
    setWrong(0);
    setStep(0);
    setStreak(0);
    setBestStreak(0);
    setStars(null);
    setHeard(null);
    setCountdown(null);
    setRhythmFlash(null);
    setFinalRhythm(null);
    setFinalIntonation(null);
    setPassInfo(null);
    countingRef.current = false;
    passRef.current = { n: 0, wrong: 0 };
    setMode("idle");
  }, [stopAccompanist]);

  /**
   * Prépare les sons. Le contexte audio est créé tout de suite (dans le geste de l'utilisateur,
   * exigé par Safari), puis les enregistrements se chargent : votre flûte (« Ma flûte ») si vous
   * l'avez enregistrée, la flûte de référence sinon, et le piano s'il y a une partie de piano.
   */
  const ensureAudio = useCallback(async () => {
    const loadFlute = (ctx: AudioContext): Promise<FlutePlayer> =>
      (isMyFluteEnabled() ? listTakes() : Promise.resolve([]))
        .then((takes) => SampledFlute.load(ctx, import.meta.env.BASE_URL, takes, isMyFluteOnly()))
        .then((f) => {
          setMyFluteSound(f.usesMyFlute);
          return f as FlutePlayer;
        })
        .catch(() => new FluteSynth(ctx));
    // Sons transmis par le mouvement précédent (transmis au démontage de celui-ci, donc lus ici).
    if (!audioRef.current && handoff && handoff.ctx.state !== "closed") audioRef.current = handoff;
    if (audioRef.current === handoff) handoff = null;
    if (!audioRef.current) {
      const ctx = new AudioContext({ latencyHint: "playback" });
      void ctx.resume();
      audioRef.current = { ctx, flute: pianoOnly ? Promise.resolve(new FluteSynth(ctx)) : loadFlute(ctx), realFlute: !pianoOnly };
    }
    const audio = audioRef.current;
    // Mouvement précédent pour piano seul : la vraie flûte n'était pas encore chargée.
    if (!pianoOnly && !audio.realFlute) {
      audio.flute = loadFlute(audio.ctx);
      audio.realFlute = true;
    }
    if (!pianoOnly && audio.realFlute) void audio.flute.then((f) => setMyFluteSound(f instanceof SampledFlute && f.usesMyFlute));
    if (!audio.piano && pianoNotesRef.current.length) audio.piano = PianoSampler.load(audio.ctx).catch(() => null);
    await audio.ctx.resume();
    synthRef.current = await audio.flute;
    pianoRef.current ??= (await audio.piano) ?? null;
  }, [pianoOnly]);

  /**
   * Horloge de l'accompagnement : `now` = heure audio programmable au plus tôt ; `heardAt(ms)` =
   * heure audio du son entendu à l'instant `ms` (horloge `performance.now()`, celle du micro).
   * Le son programmé à l'heure t est entendu quand la sortie atteint t : on cale donc le piano sur
   * l'heure de sortie correspondant à l'attaque de la flûte (`getOutputTimestamp`), ce qui inclut
   * la latence de la carte son.
   */
  const audioClock = () => {
    const ctx = synthRef.current?.ctx ?? pianoRef.current?.ctx;
    if (!ctx) return null;
    const now = ctx.currentTime;
    const stamp = ctx instanceof AudioContext && ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    const latency = ctx instanceof AudioContext ? ctx.outputLatency || ctx.baseLatency || 0 : 0;
    const heardAt = (ms: number) =>
      stamp?.contextTime !== undefined && stamp.performanceTime !== undefined && stamp.performanceTime > 0
        ? stamp.contextTime + (ms - stamp.performanceTime) / 1000
        : now - latency - (performance.now() - ms) / 1000;
    return { now, heardAt };
  };
  /** Une de vos notes a été reconnue : son attaque recale l'accompagnement. */
  const accompanyHit = (index: number, onsetMs: number | null) => {
    const a = accompanistRef.current;
    const clock = audioClock();
    if (!a || !clock) return;
    // instant de l'attaque sur l'horloge audio (détection un peu après l'attaque, plus le micro)
    const onset = clock.heardAt(Math.min(onsetMs ?? performance.now(), performance.now())) - MIC_DELAY;
    if (!a.started) {
      a.acc.start(scoreRef.current?.steps[index]?.startSec ?? 0, onset, index);
      a.started = true;
    }
    a.acc.hit(index, onset);
  };

  /** Passage à jouer : les mesures de la boucle, ou tout le morceau. */
  const currentRange = () => {
    const score = scoreRef.current;
    const p = practiceRef.current;
    const all = { first: 0, last: Math.max(0, (score?.steps.length ?? 1) - 1) };
    if (!score || !p.loopOn) return all;
    return stepRange(score.steps, p.loopFrom, p.loopTo) ?? all;
  };

  /**
   * Décompte : une mesure de clics au tempo choisi, sur l'horloge audio (premier temps plus aigu),
   * avec les chiffres à l'écran. Renvoie l'heure audio du premier temps du passage.
   */
  const playCountIn = (measure: number, quarterTempo: number): number | null => {
    const ctx = audioRef.current?.ctx;
    const score = scoreRef.current;
    if (!ctx || !score) return null;
    const meter = score.meters[measure] ?? { beats: 4, beatType: 4 };
    const { clicks, beatSec } = countIn(meter.beats, meter.beatType, quarterTempo);
    const t0 = ctx.currentTime + 0.3;
    for (let k = 0; k < clicks; k++) {
      const at = t0 + k * beatSec;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = k === 0 ? 1760 : 1320;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.35, at + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.08);
      const delay = (at - ctx.currentTime) * 1000;
      timersRef.current.push(window.setTimeout(() => setCountdown(clicks - k), Math.max(0, delay)));
    }
    const startAt = t0 + clicks * beatSec;
    const untilStart = (startAt - ctx.currentTime) * 1000;
    timersRef.current.push(
      // un peu avant le premier temps : une attaque juste à l'heure est bien entendue
      window.setTimeout(() => {
        countingRef.current = false;
      }, Math.max(0, untilStart - 150)),
      window.setTimeout(() => setCountdown(null), Math.max(0, untilStart)),
    );
    return startAt;
  };

  /** Lance un passage : partition remise au début du passage, décompte, accompagnement. */
  const beginPassRef = useRef<() => void>(() => {});
  beginPassRef.current = () => {
    const score = scoreRef.current;
    const follower = followerRef.current;
    if (!score || !follower || !micRef.current) return;
    stopAccompanist();
    synthRef.current?.stop();
    pianoRef.current?.stop();
    const p = practiceRef.current;
    const range = currentRange();
    rangeRef.current = range;
    score.resetColors();
    follower.reset(range.first);
    score.goToStep(range.first);
    setStep(range.first);
    setStreak(0);
    setHeard(null);
    passRef.current = { n: passRef.current.n + 1, wrong: 0 };
    const speed = p.tempo / score.tempo;
    if (!rhythmRef.current || p.loopOn) rhythmRef.current = new RhythmTracker(score.steps.map((x) => x.startSec), speed);
    rhythmRef.current.restart();
    const measure = score.steps[range.first]?.measure ?? 0;
    const startAt = p.countInOn ? playCountIn(measure, p.tempo) : null;
    countingRef.current = startAt !== null;

    const accompanied = (hasPiano && pianoOn) || (hasFlute2 && flute2On);
    const clock = audioClock();
    if (!accompanied || !clock || !score.steps[range.first]) return;
    const acc = new Accompanist(
      score.steps.map((x) => x.startSec),
      speed,
    );
    let started = false;
    if (startAt !== null) {
      // après le décompte, l'accompagnement part du premier temps de la mesure, avec vous
      acc.start(score.measureStartSec(measure), startAt, range.first);
      started = true;
    } else if (range.first === 0 && score.steps[0].startSec > 0.05) {
      // introduction (avant votre première note) : l'accompagnement commence seul, au tempo choisi
      acc.start(0, clock.now + 0.4);
      started = true;
    }
    const piano = pianoRef.current;
    const flute = synthRef.current;
    const timer = window.setInterval(() => {
      const c = audioClock();
      const a = accompanistRef.current;
      if (!c || !a?.started) return;
      const w = a.acc.advance(c.now, LOOKAHEAD);
      if (!w) return;
      const opts = { origin: w.from, until: w.to, speed: a.acc.tempoRatio, late: 0.25 };
      const t0 = a.acc.toAudio(w.from);
      if (piano && pianoOn) piano.schedule(pianoNotesRef.current, t0, opts);
      if (flute && flute2On) flute.scheduleAt(flute2NotesRef.current, t0, opts);
    }, 25);
    accompanistRef.current = { acc, started, timer };
  };

  /** Fin d'un passage de la boucle : bilan, tempo du passage suivant, et on recommence. */
  const passDoneRef = useRef<() => void>(() => {});
  passDoneRef.current = () => {
    const p = practiceRef.current;
    const report = rhythmRef.current?.report;
    const wrongs = passRef.current.wrong;
    const success = wrongs === 0 && (report?.percent ?? 100) >= 70;
    const next = p.progressive ? nextLoopTempo(p.tempo, p.targetTempo, success) : p.tempo;
    const parts = [
      `Passage ${passRef.current.n} : ${wrongs ? `${wrongs} fausse${wrongs > 1 ? "s" : ""} note${wrongs > 1 ? "s" : ""}` : "aucune fausse note"}`,
      report && report.evaluated ? `rythme ${report.percent} % à l'heure` : null,
      (() => {
        const worst = intonationRef.current.report.notes.find((x) => Math.abs(x.cents) >= 10);
        return worst ? `justesse : ${worst.name} trop ${worst.cents > 0 ? "haut" : "bas"} (${worst.cents > 0 ? "+" : ""}${worst.cents} c)` : null;
      })(),
      next > p.tempo
        ? `bravo, tempo ${p.tempo} → ${next}`
        : p.progressive && p.tempo >= p.targetTempo && success
          ? `objectif ♩ = ${p.targetTempo} atteint 🎉`
          : !success
            ? "on recommence au même tempo"
            : null,
    ].filter(Boolean);
    setPassInfo(parts.join(" · "));
    if (next !== p.tempo) {
      setTempo(next);
      practiceRef.current = { ...p, tempo: next };
    }
    countingRef.current = true; // pause entre deux passages : le micro est ignoré
    stopAccompanist();
    timersRef.current.push(window.setTimeout(() => beginPassRef.current(), 1600));
  };

  const startMic = useCallback(async () => {
    restart();
    setMicError(null);
    const accompanied = (hasPiano && pianoOn) || (hasFlute2 && flute2On);
    if (accompanied || practiceRef.current.countInOn) await ensureAudio();
    rhythmRef.current = null;
    intonationRef.current.reset();
    const mic = new MicPitchSource(
      (r) => {
        if (countingRef.current) return; // décompte en cours : on attend le premier temps
        setHeard(r.midi);
        const follower = followerRef.current;
        if (!follower) return;
        const events = follower.push({ midi: r.midi, timeMs: r.timeMs, level: r.level });
        // justesse de la note tenue (la dernière reconnue)
        const held = follower.position - 1;
        const heldStep = scoreRef.current?.steps[held];
        if (heldStep && !events.some((e) => e.type === "hit")) intonationRef.current.frame(held, heldStep.midi, r.midi);
        for (const ev of events) {
          if (ev.type !== "hit") continue;
          intonationRef.current.noteStarted(ev.index);
          accompanyHit(ev.index, follower.lastOnsetMs);
          // rythme : instant d'attaque comparé à l'instant attendu d'après votre tempo
          const judged = follower.lastOnsetMs !== null ? rhythmRef.current?.hit(ev.index, follower.lastOnsetMs / 1000) : null;
          if (judged) setRhythmFlash(judged.verdict);
        }
        handleEvents(events);
      },
      undefined,
      undefined,
      accompanied,
    );
    try {
      await mic.start();
      micRef.current = mic;
      setMode("mic");
      beginPassRef.current();
    } catch (e) {
      setMicError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Accès au micro refusé. Autorisez le micro dans les réglages pour jouer."
          : "Micro indisponible sur cet appareil.",
      );
    }
  }, [handleEvents, restart, hasPiano, pianoOn, hasFlute2, flute2On, ensureAudio]);

  /**
   * Mode Écouter : l'application joue le morceau à partir de la note `from`, et la partition défile.
   * Les durées viennent de la partition (changements de tempo compris) ; le curseur Tempo les
   * accélère ou les ralentit toutes dans la même proportion, comme la vitesse de lecture de MuseScore.
   */
  const playFrom = useCallback(
    (from: number, to?: number) => {
      const score = scoreRef.current;
      const synth = synthRef.current;
      if (!score || !synth) return;
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      cancelAnimationFrame(rafRef.current);
      synth.stop();
      pianoRef.current?.stop();
      const steps = score.steps.slice(from, to === undefined ? undefined : to + 1);
      if (steps.length === 0) return;
      const speed = tempo / score.tempo;
      // Boucle : du premier temps de la mesure ; depuis le début : du début du morceau, pour jouer
      // et montrer une introduction (2ᵉ flûte, piano) avant votre première note ; sinon depuis la note.
      const loopStart = to !== undefined ? score.measureStartSec(steps[0].measure) : null;
      const origin = loopStart ?? (from === 0 ? 0 : steps[0].startSec);
      // fin du passage en boucle : la fin de sa dernière note (piano et 2ᵉ flûte s'arrêtent là)
      const until = to !== undefined ? steps[steps.length - 1].startSec + steps[steps.length - 1].seconds : Infinity;
      // Instants joués : points d'orgue et ralentis écrits (warp), puis tempo choisi (speed).
      const W = warpRef.current;
      const at = (sec: number) => (W(sec) - W(origin)) / speed;
      const span = (start: number, seconds: number) => (W(start + seconds) - W(start)) / speed;
      // Le son est programmé sur l'horloge audio (rythme exact) ; l'affichage suit avec des minuteries.
      // Ce qui est écrit sur la partition : nuances, articulations, liaisons, ornements — si la
      // partition et le curseur comptent les mêmes notes (sinon, par prudence, jeu neutre).
      const written = melodyRef.current.length === score.steps.length ? melodyRef.current : [];
      const melody = steps.flatMap((s, k) => {
        const w = written[from + k];
        const note: PianoNote = {
          midi: s.midi,
          startSec: s.startSec,
          seconds: s.seconds,
          velocity: w?.velocity ?? 0.68,
          ...(w ? { slurred: w.slurred, gate: w.gate } : {}),
        };
        return (w?.ornament ? expandOrnament(note, w.ornament) : [note]).map((n) => ({
          midi: n.midi,
          start: at(n.startSec),
          duration: span(n.startSec, n.seconds),
          velocity: n.velocity,
          gate: n.gate,
          slurred: n.slurred,
        }));
      });
      // Liaisons fixées sur toute la mélodie (programmée ensuite par morceaux) : écrites, sinon
      // déduites de l'enchaînement des notes, comme le faisait la programmation d'un seul tenant.
      // une note sans heure valable (partition reconnue de travers) ne doit pas tout arrêter
      for (let i = melody.length - 1; i >= 0; i--) {
        if (!Number.isFinite(melody[i].start) || !Number.isFinite(melody[i].duration)) melody.splice(i, 1);
      }
      melody.forEach((n, i) => {
        const next = melody[i + 1];
        n.slurred ??= next !== undefined && Math.abs(next.start - (n.start + n.duration)) < 0.01;
      });
      const t0 = synth.ctx.currentTime + 0.12;
      // Piano (accompagnement, ou partition pour piano seul) : même horloge, même tempo.
      // accompagnement déjà placé sur le temps joué (points d'orgue, ralentis)
      const placed = { origin: W(origin), until: until === Infinity ? Infinity : W(until), speed };
      // Programmation au fil de l'eau : seulement les secondes à venir, en continu. Tout programmer
      // d'un coup figeait l'application sur une grande partition (orchestre : des dizaines de
      // milliers de notes d'accompagnement).
      const piano = pianoRef.current && (pianoOn || pianoOnly) ? pianoRef.current : null;
      const playedAt = (n: PianoNote) => t0 + (n.startSec - placed.origin) / speed;
      const streams = {
        melody: new NoteStream(pianoOnly ? [] : melody, (n) => t0 + n.start),
        piano: new NoteStream(piano ? warpedRef.current.piano : [], playedAt),
        flute2: new NoteStream(flute2On && !pianoOnly ? warpedRef.current.flute2 : [], playedAt),
      };
      let lastTune: (typeof melody)[number] | undefined;
      const pump = () => {
        const horizon = synth.ctx.currentTime + SCHEDULE_AHEAD;
        const tune = streams.melody.take(horizon);
        if (tune.length) synth.schedule(tune, 0, t0, lastTune);
        if (tune.length) lastTune = tune[tune.length - 1];
        const chords = streams.piano.take(horizon);
        if (piano && chords.length) piano.schedule(chords, t0, placed);
        const second = streams.flute2.take(horizon);
        if (second.length) synth.scheduleAt(second, t0, placed);
      };
      pump();
      timersRef.current.push(window.setInterval(pump, SCHEDULE_EVERY_MS));
      // Le curseur suit l'horloge audio, pas des minuteries : à chaque image, on regarde l'instant
      // réellement entendu (latence de sortie de la carte son comprise) et on place le curseur sur
      // la note qui sonne. Si la page a été ralentie, il rattrape aussitôt au lieu d'accumuler du retard.
      const ctx = synth.ctx;
      const latency = ctx instanceof AudioContext ? (ctx.outputLatency || ctx.baseLatency || 0) : 0;
      const starts = steps.map((s) => t0 + at(s.startSec));
      const last = steps[steps.length - 1];
      // fin : après votre dernière note et après celle de la 2ᵉ flûte, si elle finit plus tard
      // (boucle, pas d'étalement d'un tableau : une longue partie dépasserait la limite d'arguments)
      let flute2End = 0;
      if (flute2On && !pianoOnly) {
        for (const n of flute2NotesRef.current) if (n.startSec < until) flute2End = Math.max(flute2End, at(Math.min(n.startSec + n.seconds, until)));
      }
      const endAt = t0 + Math.max(at(last.startSec) + span(last.startSec, last.seconds), flute2End) + 0.3;
      let shown = -1; // dernière note affichée (indice dans `steps`)
      // Le curseur parcourt toutes les notes jouées (les vôtres et celles de la 2ᵉ flûte affichée),
      // même pendant vos silences ; la note « À jouer » et les couleurs restent sur votre partie.
      const positions = score.positions.filter((p) => p.startSec >= origin - 1e-6 && p.startSec < until);
      const posStarts = positions.map((p) => t0 + at(p.startSec));
      let shownPos = -1;
      const tick = () => {
        const heardAt = ctx.currentTime - latency;
        if (heardAt >= endAt && to !== undefined && practiceRef.current.loopOn) {
          // boucle : on rejoue le passage après un court silence
          score.resetColors();
          timersRef.current.push(window.setTimeout(() => playFrom(from, to), 700));
          return;
        }
        if (heardAt >= endAt) {
          score.resetColors();
          score.goToStep(0);
          listenStepRef.current = 0;
          setStep(0);
          setHeard(null);
          setMode("idle");
          // Mouvement suivant de l'œuvre : il s'ouvre et se joue tout seul, après une courte pause.
          const next = chainRef.current;
          if (next) {
            setUpcoming(next.entry);
            timersRef.current.push(window.setTimeout(() => next.open(), 2000));
          }
          return;
        }
        let q = shownPos;
        while (q + 1 < posStarts.length && posStarts[q + 1] <= heardAt) q++;
        if (q > shownPos) {
          score.goToCursor(positions[q].cursorIndex);
          shownPos = q;
        }
        let k = shown;
        while (k + 1 < starts.length && starts[k + 1] <= heardAt) k++;
        if (k > shown) {
          for (let j = Math.max(shown, 0); j < k; j++) score.color(from + j, COLORS.hit);
          if (from + k > 0 && shown < 0) score.color(from + k - 1, COLORS.hit);
          score.color(from + k, COLORS.current);
          listenStepRef.current = from + k;
          setStep(from + k);
          setHeard(steps[k].midi);
          shown = k;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [tempo, pianoOn, flute2On, pianoOnly],
  );

  // Lu à la fin de l'écoute : le mouvement à enchaîner, s'il y en a un et si l'enchaînement est activé.
  const chainRef = useRef<{ entry: CatalogEntry; open: () => void } | null>(null);
  const openMovement = useCallback(
    (target: CatalogEntry, listen: boolean) => {
      handingOffRef.current = true;
      onOpenMovement?.(target, listen);
    },
    [onOpenMovement],
  );
  chainRef.current =
    chain && nextMovement && onOpenMovement ? { entry: nextMovement, open: () => openMovement(nextMovement, true) } : null;

  const startListen = useCallback(async () => {
    restart();
    setMicError(null);
    if ((scoreRef.current?.steps.length ?? 0) === 0 && pianoNotesRef.current.length === 0) {
      setMicError("⚠️ Aucune note à jouer n'a été trouvée dans cette partition (reconnaissance du PDF ratée ?).");
      return;
    }
    try {
      await ensureAudio();
      setMode("listen");
      // boucle : le passage choisi, en continu ; sinon tout le morceau
      const range = currentRange();
      rangeRef.current = range;
      listenStepRef.current = range.first;
      if (practiceRef.current.loopOn) playFrom(range.first, range.last);
      else playFrom(0);
    } catch (e) {
      // jamais d'échec muet : on dit pourquoi l'écoute n'a pas démarré
      restart();
      setMode("idle");
      setMicError(`⚠️ Écoute impossible : ${e instanceof Error ? e.message : String(e)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restart, playFrom, ensureAudio]);

  // Mouvement enchaîné : l'écoute démarre dès que la partition est prête.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoListen || loading || loadError || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void startListen();
  }, [autoListen, loading, loadError, startListen]);

  // Tempo changé pendant l'écoute : on repart de la note en cours à la nouvelle vitesse.
  useEffect(() => {
    if (modeRef.current !== "listen") return;
    if (practiceRef.current.loopOn) playFrom(rangeRef.current.first, rangeRef.current.last);
    else playFrom(listenStepRef.current);
  }, [playFrom]);

  /** Sans flûte sous la main : valide la note attendue (entraînement / accessibilité). */
  const skipNote = useCallback(() => {
    const follower = followerRef.current;
    const score = scoreRef.current;
    if (!follower || !score || follower.done) return;
    const index = follower.position;
    if (countingRef.current) return;
    if (practiceRef.current.loopOn && index === rangeRef.current.last) {
      score.color(index, COLORS.hit);
      passDoneRef.current();
      return;
    }
    follower.reset(index + 1);
    accompanyHit(index, performance.now());
    score.color(index, COLORS.hit);
    score.goToStep(index + 1);
    setStep(index + 1);
    if (follower.done) finish(wrongRef.current);
  }, [finish]);

  // --- Correction de notes (partitions importées) -------------------------------------------
  const selectEdit = useCallback((i: number | null) => {
    const ctrl = scoreRef.current;
    if (!ctrl) return;
    ctrl.resetColors();
    if (i === null || !ctrl.steps[i]) {
      setEditStep(null);
      return;
    }
    ctrl.goToCursor(ctrl.steps[i].cursorIndex);
    ctrl.color(i, EDIT_COLOR);
    setEditStep(i);
  }, []);

  /** Fait entendre la note (avec le son de flûte de l'écoute). */
  const previewNote = useCallback(
    (midi: number) => {
      void ensureAudio()
        .then(() => synthRef.current?.play(midi, 0.6))
        .catch(() => {});
    },
    [ensureAudio],
  );

  /** Redessine la partition corrigée sans bouger la page, et garde la note choisie. */
  const rerenderEdited = useCallback(
    async (xml: string, select: number | null) => {
      const ctrl = scoreRef.current;
      if (!ctrl) return;
      xmlRef.current = xml;
      const y = window.scrollY;
      await ctrl.load(withPartnerFlutes(xml, displayAccompRef.current));
      setTotal(ctrl.steps.length);
      selectEdit(select === null || ctrl.steps.length === 0 ? null : Math.min(select, ctrl.steps.length - 1));
      window.scrollTo(0, y);
      requestAnimationFrame(() => window.scrollTo(0, y));
    },
    [selectEdit],
  );

  const startEditing = useCallback(() => {
    restart();
    const ctrl = scoreRef.current;
    const xml = xmlRef.current;
    if (!ctrl || !xml) return;
    undoRef.current = [];
    setCanUndo(false);
    setEditMessage(null);
    setEditing(true);
    selectEdit(null);
  }, [restart, selectEdit]);

  const finishEditing = useCallback(() => {
    setEditing(false);
    setEditStep(null);
    setEditMessage(null);
    if (undoRef.current.length > 0) setRevision((r) => r + 1); // sons, suivi et tempo d'après la partition corrigée
    else restart();
    undoRef.current = [];
    setCanUndo(false);
  }, [restart]);

  const applyEdit = useCallback(
    async (edit: NoteEdit) => {
      const before = xmlRef.current;
      const ref = editStep !== null ? scoreRef.current?.steps[editStep] : undefined;
      if (editStep === null || !ref || !before || editBusy) return;
      if (!canEditNote(before, ref)) {
        setEditMessage("⚠️ Cette note n'a pas été retrouvée dans le fichier : corrigez-la dans MuseScore.");
        return;
      }
      const result = applyNoteEdit(before, ref, edit);
      if (!result || (result.midi !== null && (result.midi < FLUTE_LOW || result.midi > FLUTE_HIGH))) {
        setEditMessage(`Impossible : la note sortirait de la tessiture de la flûte (${midiToName(FLUTE_LOW)}–${midiToName(FLUTE_HIGH)}).`);
        return;
      }
      setEditBusy(true);
      try {
        await rerenderEdited(result.xml, editStep);
        await updateUserScoreXml(entry.id, result.xml);
        undoRef.current.push(before);
        setCanUndo(true);
        setEditMessage(result.midi === null ? "🔇 Remplacée par un silence. Enregistré ✓" : `${midiToName(result.midi)} · enregistré ✓`);
        if (result.midi !== null) previewNote(result.midi);
      } catch (e) {
        await rerenderEdited(before, editStep).catch(() => {});
        setEditMessage(`⚠️ Correction impossible : ${(e as Error).message}`);
      } finally {
        setEditBusy(false);
      }
    },
    [editStep, editBusy, rerenderEdited, entry.id, previewNote],
  );

  const undoEdit = useCallback(async () => {
    const previous = undoRef.current.pop();
    setCanUndo(undoRef.current.length > 0);
    if (!previous || editBusy) return;
    setEditBusy(true);
    try {
      await rerenderEdited(previous, editStep);
      await updateUserScoreXml(entry.id, previous);
      setEditMessage("↶ Correction annulée. Enregistré ✓");
    } catch (e) {
      setEditMessage(`⚠️ ${(e as Error).message}`);
    } finally {
      setEditBusy(false);
    }
  }, [editBusy, editStep, rerenderEdited, entry.id]);

  const pickEditNote = useCallback(
    (clientX: number, clientY: number) => {
      const i = scoreRef.current?.stepAt(clientX, clientY) ?? null;
      if (i === null) return;
      selectEdit(i);
      setEditMessage(null);
      const midi = scoreRef.current?.steps[i]?.midi;
      if (midi !== undefined) previewNote(midi);
    },
    [selectEdit, previewNote],
  );

  // Clavier pendant la correction : ← → choisir, ↑ ↓ demi-ton (Maj : octave), Suppr silence.
  useEffect(() => {
    if (!editing) return;
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const n = scoreRef.current?.steps.length ?? 0;
      if (e.key === "Escape") finishEditing();
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") void undoEdit();
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const next = editStep === null ? 0 : editStep + (e.key === "ArrowRight" ? 1 : -1);
        if (next >= 0 && next < n) {
          selectEdit(next);
          const midi = scoreRef.current?.steps[next]?.midi;
          if (midi !== undefined) previewNote(midi);
        }
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const by = e.key === "ArrowUp" ? 1 : -1;
        void applyEdit(e.shiftKey ? { kind: "octave", by } : { kind: "semitone", by });
      } else if (e.key === "Delete" || e.key === "Backspace") void applyEdit({ kind: "rest" });
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, editStep, applyEdit, undoEdit, finishEditing, selectEdit, previewNote]);

  const editedStep = editStep !== null ? scoreRef.current?.steps[editStep] : undefined;
  // pendant la correction, la note choisie et son doigté
  const shownMidi = editing ? (editedStep?.midi ?? null) : expectedMidi;

  const cents = heard !== null && expectedMidi !== null ? centsOff(heard, expectedMidi) : null;
  const inTune = cents !== null && Math.abs(cents) <= DEFAULT_FOLLOWER_OPTIONS.toleranceCents;

  return (
    <main className={mode === "listen" || mode === "mic" ? "player playing" : "player"}>
      <header className="player-bar" data-tauri-drag-region>
        <button className="ghost" onClick={onBack}>
          ← Bibliothèque
        </button>
        <div className="player-title">
          <strong>{entry.title}</strong>
          <span>
            {entry.composer} · Niveau {entry.level} ({LEVEL_LABELS[entry.level]})
            {movements.length > 1 && ` · Mouvement ${movementIndex + 1}/${movements.length}`}
          </span>
        </div>
        <div className="player-desktop-tools">
          <div className="zoom-controls" role="group" aria-label="Zoom de la partition">
            <button className="ghost-pill tool-btn" onClick={() => applyZoom(zoom - 0.15)} title="Réduire la partition (touche -)">
              🔍 −
            </button>
            <span className="zoom-label" title="Échelle">{Math.round(zoom * 100)}%</span>
            <button className="ghost-pill tool-btn" onClick={() => applyZoom(zoom + 0.15)} title="Agrandir la partition (touche +)">
              🔍 +
            </button>
          </div>
          <button
            className={`ghost-pill pupitre-btn ${isFullscreen ? "active" : ""}`}
            onClick={toggleFullscreen}
            title="Mode pupitre plein écran (raccourci : touche F)"
          >
            {isFullscreen ? "✕ Quitter pupitre" : "⛶ Mode Pupitre"}
          </button>
        </div>
        <span className="best">Record : {"★".repeat(bestStars) || "—"}</span>
      </header>

      <section className="hud">
        <div className="note-box expected">
          <small>{editing ? "Note choisie" : "À jouer"}</small>
          <b>{shownMidi !== null && mode !== "finished" ? midiToName(shownMidi) : "—"}</b>
        </div>
        <div className={`note-box heard ${heard === null ? "" : inTune ? "good" : "off"}`}>
          <small>J'entends</small>
          <b>{heard !== null ? midiToName(heard) : "…"}</b>
          <div className="tuner" aria-hidden>
            <span style={{ left: `${50 + Math.max(-50, Math.min(50, (cents ?? 0) / 2))}%` }} />
          </div>
        </div>
        {!pianoOnly && <Fingering midi={mode === "finished" ? null : shownMidi} />}
        <div className="stats">
          <span>
            🎵 {Math.min(step, total)}/{total}
          </span>
          <span>🔥 {streak}</span>
          <span>❌ {wrong}</span>
          {rhythmFlash && <span className={`rhythm-flash ${rhythmFlash}`}>{RHYTHM_LABELS[rhythmFlash]}</span>}
        </div>
      </section>

      <div className="progress" aria-hidden>
        <span style={{ width: total ? `${(Math.min(step, total) / total) * 100}%` : 0 }} />
      </div>

      {editing ? (
        <section className="note-editor" aria-label="Correction des notes">
          <p className="edit-hint">
            {editedStep && editStep !== null ? (
              <>
                Note {editStep + 1}/{total} · mesure {editedStep.measure + 1} : <b>{midiToName(editedStep.midi)}</b>
              </>
            ) : (
              "✏️ Touchez la note fausse sur la partition."
            )}
          </p>
          <div className="edit-buttons">
            <button onClick={() => editStep !== null && editStep > 0 && selectEdit(editStep - 1)} disabled={editStep === null || editStep === 0} title="Note précédente (←)">
              ◀
            </button>
            <button
              onClick={() => selectEdit(editStep === null ? 0 : Math.min(total - 1, editStep + 1))}
              disabled={editStep !== null && editStep >= total - 1}
              title="Note suivante (→)"
            >
              ▶
            </button>
            <button onClick={() => void applyEdit({ kind: "semitone", by: -1 })} disabled={editStep === null || editBusy} title="Un demi-ton plus bas (↓)">
              ♭ ½ ton plus bas
            </button>
            <button onClick={() => void applyEdit({ kind: "semitone", by: 1 })} disabled={editStep === null || editBusy} title="Un demi-ton plus haut (↑)">
              ♯ ½ ton plus haut
            </button>
            <button onClick={() => void applyEdit({ kind: "octave", by: -1 })} disabled={editStep === null || editBusy} title="Une octave plus bas (Maj + ↓)">
              ⬇ Octave
            </button>
            <button onClick={() => void applyEdit({ kind: "octave", by: 1 })} disabled={editStep === null || editBusy} title="Une octave plus haut (Maj + ↑)">
              ⬆ Octave
            </button>
            <button onClick={() => void applyEdit({ kind: "rest" })} disabled={editStep === null || editBusy} title="Remplacer par un silence (Suppr)">
              🔇 Silence
            </button>
            <button onClick={() => void undoEdit()} disabled={!canUndo || editBusy} title="Annuler la dernière correction (Ctrl/⌘ + Z)">
              ↶ Annuler
            </button>
            <button className="primary" onClick={finishEditing} disabled={editBusy}>
              ✓ Terminer
            </button>
          </div>
          {editMessage && <p className="edit-message" role="status">{editMessage}</p>}
          <p className="edit-tip">
            Chaque correction est enregistrée sur cet appareil. Clavier : ← → choisir · ↑ ↓ demi-ton · Maj + ↑ ↓ octave ·
            Suppr silence · Échap terminer.
          </p>
        </section>
      ) : (
      <section className="controls">
        {pianoOnly ? null : mode === "mic" ? (
          <button className="primary" onClick={restart}>
            ⏹ Arrêter
          </button>
        ) : (
          <button className="primary" onClick={startMic} disabled={loading}>
            🎤 Jouer avec ma flûte
          </button>
        )}
        <button onClick={mode === "listen" ? restart : startListen} disabled={loading}>
          {mode === "listen" ? "⏹ Stop" : "🔊 Écouter"}
        </button>
        {!pianoOnly && (
          <button onClick={skipNote} disabled={loading || mode === "listen" || mode === "finished"}>
            ⏭ Note suivante
          </button>
        )}
        <button onClick={restart} disabled={loading}>
          ↺ Recommencer
        </button>
        {canEdit && (
          <button onClick={startEditing} disabled={loading} title="Corriger une note mal reconnue (import PDF)">
            ✏️ Corriger des notes
          </button>
        )}
        <label className="slider">
          Tempo ♩ = {tempo}
          <input type="range" min={30} max={240} value={tempo} onChange={(e) => setTempo(Number(e.target.value))} />
          {tempo !== writtenTempo && (
            <button className="link" onClick={() => setTempo(writtenTempo)} title="Revenir au tempo de la partition">
              partition : {writtenTempo}
            </button>
          )}
        </label>
        {hasPiano && !pianoOnly && (
          <label className="toggle" title="Accompagnement de piano, pendant l'écoute et pendant que vous jouez">
            <input type="checkbox" checked={pianoOn} onChange={(e) => setPianoOn(e.target.checked)} />
            🎹 Piano
          </label>
        )}
        {hasFlute2 && !pianoOnly && (
          <label className="toggle" title="Vous jouez la 1ʳᵉ flûte, l'application joue la 2ᵉ">
            <input type="checkbox" checked={flute2On} onChange={(e) => setFlute2On(e.target.checked)} />
            🎶 2ᵉ flûte
          </label>
        )}
        {movements.length > 1 && onOpenMovement && (
          <>
            <label className="toggle" title="À la fin de l'écoute, le mouvement suivant se joue tout seul">
              <input
                type="checkbox"
                checked={chain}
                onChange={(e) => {
                  setChain(e.target.checked);
                  try {
                    localStorage.setItem(CHAIN_KEY, e.target.checked ? "on" : "off");
                  } catch {
                    /* préférence non mémorisée */
                  }
                }}
              />
              ⏭ Enchaîner les mouvements
            </label>
            {nextMovement && (
              <button onClick={() => openMovement(nextMovement, false)} title={nextMovement.title}>
                Mouvement suivant ▶
              </button>
            )}
          </>
        )}
        {!pianoOnly && (
          <label className="toggle">
            <input type="checkbox" checked={octaveTolerant} onChange={(e) => setOctaveTolerant(e.target.checked)} />
            Octave libre
          </label>
        )}
      </section>
      )}
      {!editing && editMessage && <p className="message error">{editMessage}</p>}
      {!pianoOnly && !editing && (
        <section className="practice" aria-label="Outils de travail">
          <label className="toggle" title="Une mesure de clics au tempo choisi avant de jouer">
            <input
              id="practice-count-in"
              type="checkbox"
              checked={countInOn}
              onChange={(e) => {
                setCountInOn(e.target.checked);
                try {
                  localStorage.setItem(COUNT_IN_KEY, e.target.checked ? "on" : "off");
                } catch {
                  /* préférence non mémorisée */
                }
              }}
            />
            🥁 Décompte
          </label>
          <label className="toggle" title="Rejouer un passage en boucle">
            <input id="practice-loop" type="checkbox" checked={loopOn} onChange={(e) => setLoopOn(e.target.checked)} />
            🔁 Boucle
          </label>
          {loopOn && (
            <span className="loop-settings">
              <label>
                mesures
                <input
                  id="loop-from"
                  type="number"
                  min={1}
                  max={measureCount}
                  value={loopFrom}
                  onChange={(e) => setLoopFrom(Math.max(1, Math.min(measureCount, Number(e.target.value) || 1)))}
                />
              </label>
              <label>
                à
                <input
                  id="loop-to"
                  type="number"
                  min={1}
                  max={measureCount}
                  value={loopTo}
                  onChange={(e) => setLoopTo(Math.max(1, Math.min(measureCount, Number(e.target.value) || 1)))}
                />
              </label>
              <label className="toggle" title={`Après chaque passage sans faute, le tempo monte de 4`}>
                <input id="loop-progressive" type="checkbox" checked={progressive} onChange={(e) => setProgressive(e.target.checked)} />
                ⏫ Tempo progressif
              </label>
              {progressive && (
                <label>
                  jusqu'à ♩ =
                  <input
                    id="loop-target"
                    type="number"
                    min={30}
                    max={240}
                    value={targetTempo}
                    onChange={(e) => setTargetTempo(Math.max(30, Math.min(240, Number(e.target.value) || writtenTempo)))}
                  />
                </label>
              )}
            </span>
          )}
        </section>
      )}
      {loopOn && mode === "idle" && !pianoOnly && (
        <p className="sound-note">
          🔁 Mesures {Math.min(loopFrom, loopTo)} à {Math.max(loopFrom, loopTo)} en boucle.
          {progressive && tempo < targetTempo && ` Commencez lentement (♩ = ${tempo}) : chaque passage sans faute, et assez régulier, fait monter le tempo de 4, jusqu'à ${targetTempo}.`}
        </p>
      )}
      {passInfo && mode === "mic" && <p className="pass-info" role="status">{passInfo}</p>}
      {micError && <p className="message error">{micError}</p>}
      {upcoming && <p className="sound-note">⏭ Mouvement suivant : « {upcoming.title} »…</p>}
      {mode === "listen" && myFluteSound && !pianoOnly && <p className="sound-note">🎙️ Son : votre flûte{isMyFluteOnly() ? " (uniquement)" : ""}</p>}
      {pianoOnly && (
        <p className="sound-note">🎹 Partition pour piano : appuyez sur « Écouter » pour l'entendre au piano.</p>
      )}
      {mode === "mic" && ((hasPiano && pianoOn) || (hasFlute2 && flute2On)) && (
        <p className="sound-note">
          {hasFlute2 && flute2On ? "🎶 Vous jouez la 1ʳᵉ flûte, l'application la 2ᵉ" : "🎹 Le piano vous accompagne"}
          {hasPiano && pianoOn && hasFlute2 && flute2On ? " avec le piano" : ""} : elle suit votre jeu. Un casque est
          conseillé pour que le micro n'entende que vous.
        </p>
      )}
      {entry.origin === "omr" && (
        <p className="omr-note">
          🔍 Partition reconnue automatiquement à partir d'un PDF scanné : une note peut être fausse. En cas de doute,
          comparez avec l'original{entry.sourceUrl ? " sur IMSLP" : ""}.
        </p>
      )}

      {countdown !== null && (
        <div className="countdown" aria-live="assertive">
          <span key={countdown}>{countdown}</span>
        </div>
      )}

      <section className="sheet">
        {loading && !loadError && <p className="message">Préparation de la partition…</p>}
        {loadError && <p className="message error">⚠️ {loadError}</p>}
        <div
          ref={containerRef}
          className={editing ? "editing" : undefined}
          onClick={editing ? (e) => pickEditNote(e.clientX, e.clientY) : undefined}
        />
      </section>

      {praise && <div className="praise">{praise}</div>}

      {mode === "finished" && stars !== null && (
        <div className="overlay" role="dialog" aria-label="Morceau terminé">
          <div className="confetti" aria-hidden>
            {Array.from({ length: 24 }, (_, i) => (
              <span key={i} style={{ left: `${(i * 37) % 100}%`, animationDelay: `${(i % 6) * 0.15}s` }}>
                {["🎵", "🎶", "⭐", "✨"][i % 4]}
              </span>
            ))}
          </div>
          <div className="result">
            <h2>Morceau terminé !</h2>
            <p className="big-stars">{[1, 2, 3].map((i) => (i <= stars ? "★" : "☆")).join(" ")}</p>
            <p>
              {total} notes · {wrong} fausse{wrong > 1 ? "s" : ""} note{wrong > 1 ? "s" : ""} · meilleure série {bestStreak}
            </p>
            {finalRhythm && <p className="rhythm-summary">⏱ {rhythmSummary(finalRhythm)}</p>}
            {finalIntonation && (() => {
              const s = intonationSummary(finalIntonation);
              return (
                <div className="intonation-summary">
                  <p>🎯 {s.headline}</p>
                  {s.details.length > 0 && (
                    <ul>
                      {s.details.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })()}
            <div className="controls">
              <button className="primary" onClick={startMic}>
                🎤 Rejouer
              </button>
              <button onClick={onBack}>Autre morceau</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
