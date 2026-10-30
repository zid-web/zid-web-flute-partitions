import { useCallback, useEffect, useRef, useState } from "react";
import {
  expandOrnament,
  melodyNotes,
  pianoNotes,
  splitAccompaniment,
  type MelodyNote,
  type PianoNote,
} from "../lib/accompaniment";
import { LEVEL_LABELS, loadAccompanimentXml, loadScoreXml, type CatalogEntry } from "../lib/catalog";
import { DEFAULT_FOLLOWER_OPTIONS, ScoreFollower, starsFor, type FollowerEvent } from "../lib/follower";
import { centsOff, midiToName } from "../lib/notes";
import { MicPitchSource } from "../lib/pitch";
import { recordResult, type PieceProgress } from "../lib/progress";
import { COLORS, ScoreController } from "../lib/score";
import { isMyFluteEnabled, listTakes } from "../lib/myFlute";
import { PianoSampler } from "../lib/piano";
import { SampledFlute, type FlutePlayer } from "../lib/sampler";
import { FluteSynth } from "../lib/synth";
import { Fingering } from "./Fingering";

interface Props {
  entry: CatalogEntry;
  bestStars: number;
  onBack: () => void;
  onProgress: (p: Record<string, PieceProgress>) => void;
}

type Mode = "idle" | "mic" | "listen" | "finished";

const PRAISE = ["Bravo !", "Super !", "Magnifique !", "Quelle oreille !", "Continuez !", "Parfait !"];

export function Player({ entry, bestStars, onBack, onProgress }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scoreRef = useRef<ScoreController | null>(null);
  const followerRef = useRef<ScoreFollower | null>(null);
  const micRef = useRef<MicPitchSource | null>(null);
  const synthRef = useRef<FlutePlayer | null>(null);
  // Sons, chargés au premier « Écouter » ou « Jouer » : vraie flûte (le synthétiseur ne sert que si
  // elle ne peut pas être chargée) et vrai piano pour l'accompagnement, sur un même contexte audio.
  const audioRef = useRef<{ ctx: AudioContext; flute: Promise<FlutePlayer>; piano?: Promise<PianoSampler | null> } | null>(null);
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

  const listenStepRef = useRef(0);
  const modeRef = useRef<Mode>("idle");
  modeRef.current = mode;

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
        // Parties jouées par l'application : toute la partition (piano seul), ou l'accompagnement gardé
        // à l'import ou publié avec le morceau (piano et/ou 2ᵉ flûte).
        melodyRef.current = entry.kind === "piano" ? [] : melodyNotes(xml);
        if (entry.kind === "piano") {
          pianoNotesRef.current = pianoNotes(xml);
          flute2NotesRef.current = [];
        } else {
          const accompaniment = await loadAccompanimentXml(entry).catch(() => null);
          const parts = accompaniment ? splitAccompaniment(accompaniment) : { piano: [], flute: [] };
          pianoNotesRef.current = parts.piano;
          flute2NotesRef.current = parts.flute;
        }
        if (!cancelled) {
          setHasPiano(pianoNotesRef.current.length > 0);
          setHasFlute2(flute2NotesRef.current.length > 0);
        }
        return controller.load(xml);
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
        setLoading(false);
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
      micRef.current?.stop();
      synthRef.current?.close();
      timersRef.current.forEach(clearTimeout);
      cancelAnimationFrame(rafRef.current);
      controller.dispose();
    };
  }, [entry]);

  useEffect(() => {
    followerRef.current?.setOptions({ ...DEFAULT_FOLLOWER_OPTIONS, octaveTolerant });
  }, [octaveTolerant]);

  const finish = useCallback(
    (wrongCount: number) => {
      const s = starsFor(total, wrongCount);
      setStars(s);
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
          setWrong(wrongRef.current);
          setStreak(0);
          score.color(ev.index, COLORS.wrong);
          window.setTimeout(() => {
            if (followerRef.current?.position === ev.index) score.color(ev.index, COLORS.current);
          }, 450);
        } else if (ev.type === "finished") {
          finish(wrongRef.current);
        }
      }
    },
    [finish],
  );

  useEffect(() => {
    if (!praise) return;
    const t = window.setTimeout(() => setPraise(null), 1400);
    return () => clearTimeout(t);
  }, [praise]);

  const restart = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    cancelAnimationFrame(rafRef.current);
    synthRef.current?.stop();
    pianoRef.current?.stop();
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
    setMode("idle");
  }, []);

  /**
   * Prépare les sons. Le contexte audio est créé tout de suite (dans le geste de l'utilisateur,
   * exigé par Safari), puis les enregistrements se chargent : votre flûte (« Ma flûte ») si vous
   * l'avez enregistrée, la flûte de référence sinon, et le piano s'il y a une partie de piano.
   */
  const ensureAudio = useCallback(async () => {
    if (!audioRef.current) {
      const ctx = new AudioContext({ latencyHint: "playback" });
      void ctx.resume();
      const flute: Promise<FlutePlayer> = pianoOnly
        ? Promise.resolve(new FluteSynth(ctx))
        : (isMyFluteEnabled() ? listTakes() : Promise.resolve([]))
            .then((takes) => SampledFlute.load(ctx, import.meta.env.BASE_URL, takes))
            .then((f) => {
              setMyFluteSound(f.usesMyFlute);
              return f as FlutePlayer;
            })
            .catch(() => new FluteSynth(ctx));
      audioRef.current = { ctx, flute };
    }
    const audio = audioRef.current;
    if (!audio.piano && pianoNotesRef.current.length) audio.piano = PianoSampler.load(audio.ctx).catch(() => null);
    await audio.ctx.resume();
    synthRef.current ??= await audio.flute;
    pianoRef.current ??= (await audio.piano) ?? null;
  }, [pianoOnly]);

  // Accompagnement pendant que vous jouez : à chaque note réussie, le piano joue sa partie
  // jusqu'à votre note suivante (il vous suit, même si vous ralentissez).
  const accompanyRef = useRef<(index: number) => void>(() => {});
  accompanyRef.current = (index: number) => {
    const score = scoreRef.current;
    const from = score?.steps[index];
    if (!score || !from) return;
    const window = { origin: from.startSec, until: score.steps[index + 1]?.startSec ?? Infinity, speed: tempo / score.tempo };
    const piano = pianoRef.current;
    if (piano && pianoOn) piano.schedule(pianoNotesRef.current, piano.ctx.currentTime + 0.01, window);
    const flute = synthRef.current;
    if (flute && flute2On) flute.scheduleAt(flute2NotesRef.current, flute.ctx.currentTime + 0.01, window);
  };

  const startMic = useCallback(async () => {
    restart();
    setMicError(null);
    const accompanied = (hasPiano && pianoOn) || (hasFlute2 && flute2On);
    if (accompanied) await ensureAudio();
    const mic = new MicPitchSource(
      (r) => {
        setHeard(r.midi);
        const follower = followerRef.current;
        if (!follower) return;
        const events = follower.push({ midi: r.midi, timeMs: r.timeMs, level: r.level });
        for (const ev of events) if (ev.type === "hit") accompanyRef.current(ev.index);
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
      // Introduction (avant votre première note), au tempo choisi : piano et/ou 2ᵉ flûte.
      const score = scoreRef.current;
      if (accompanied && score?.steps[0]) {
        const intro = { until: score.steps[0].startSec, speed: tempo / score.tempo };
        const piano = pianoRef.current;
        if (piano && pianoOn) piano.schedule(pianoNotesRef.current, piano.ctx.currentTime + 0.3, intro);
        const flute = synthRef.current;
        if (flute && flute2On) flute.scheduleAt(flute2NotesRef.current, flute.ctx.currentTime + 0.3, intro);
      }
    } catch (e) {
      setMicError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Accès au micro refusé. Autorisez le micro dans les réglages pour jouer."
          : "Micro indisponible sur cet appareil.",
      );
    }
  }, [handleEvents, restart, hasPiano, pianoOn, hasFlute2, flute2On, ensureAudio, tempo]);

  /**
   * Mode Écouter : l'application joue le morceau à partir de la note `from`, et la partition défile.
   * Les durées viennent de la partition (changements de tempo compris) ; le curseur Tempo les
   * accélère ou les ralentit toutes dans la même proportion, comme la vitesse de lecture de MuseScore.
   */
  const playFrom = useCallback(
    (from: number) => {
      const score = scoreRef.current;
      const synth = synthRef.current;
      if (!score || !synth) return;
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      cancelAnimationFrame(rafRef.current);
      synth.stop();
      pianoRef.current?.stop();
      const steps = score.steps.slice(from);
      if (steps.length === 0) return;
      const speed = tempo / score.tempo;
      const origin = steps[0].startSec;
      const at = (sec: number) => (sec - origin) / speed;
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
          duration: n.seconds / speed,
          velocity: n.velocity,
          gate: n.gate,
          slurred: n.slurred,
        }));
      });
      const t0 = pianoOnly ? synth.ctx.currentTime + 0.12 : synth.schedule(melody);
      // Piano (accompagnement, ou partition pour piano seul) : même horloge, même tempo.
      if (pianoRef.current && (pianoOn || pianoOnly)) pianoRef.current.schedule(pianoNotesRef.current, t0, { origin, speed });
      if (flute2On && !pianoOnly) synth.scheduleAt(flute2NotesRef.current, t0, { origin, speed });
      // Le curseur suit l'horloge audio, pas des minuteries : à chaque image, on regarde l'instant
      // réellement entendu (latence de sortie de la carte son comprise) et on place le curseur sur
      // la note qui sonne. Si la page a été ralentie, il rattrape aussitôt au lieu d'accumuler du retard.
      const ctx = synth.ctx;
      const latency = ctx instanceof AudioContext ? (ctx.outputLatency || ctx.baseLatency || 0) : 0;
      const starts = steps.map((s) => t0 + at(s.startSec));
      const last = steps[steps.length - 1];
      const endAt = t0 + at(last.startSec) + last.seconds / speed + 0.3;
      let shown = -1; // dernière note affichée (indice dans `steps`)
      const tick = () => {
        const heardAt = ctx.currentTime - latency;
        if (heardAt >= endAt) {
          score.resetColors();
          score.goToStep(0);
          listenStepRef.current = 0;
          setStep(0);
          setHeard(null);
          setMode("idle");
          return;
        }
        let k = shown;
        while (k + 1 < starts.length && starts[k + 1] <= heardAt) k++;
        if (k > shown) {
          for (let j = Math.max(shown, 0); j < k; j++) score.color(from + j, COLORS.hit);
          if (from + k > 0 && shown < 0) score.color(from + k - 1, COLORS.hit);
          score.goToStep(from + k);
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

  const startListen = useCallback(async () => {
    restart();
    await ensureAudio();
    setMode("listen");
    listenStepRef.current = 0;
    playFrom(0);
  }, [restart, playFrom, ensureAudio]);

  // Tempo changé pendant l'écoute : on repart de la note en cours à la nouvelle vitesse.
  useEffect(() => {
    if (modeRef.current === "listen") playFrom(listenStepRef.current);
  }, [playFrom]);

  /** Sans flûte sous la main : valide la note attendue (entraînement / accessibilité). */
  const skipNote = useCallback(() => {
    const follower = followerRef.current;
    const score = scoreRef.current;
    if (!follower || !score || follower.done) return;
    const index = follower.position;
    follower.reset(index + 1);
    score.color(index, COLORS.hit);
    score.goToStep(index + 1);
    setStep(index + 1);
    if (follower.done) finish(wrongRef.current);
  }, [finish]);

  const cents = heard !== null && expectedMidi !== null ? centsOff(heard, expectedMidi) : null;
  const inTune = cents !== null && Math.abs(cents) <= DEFAULT_FOLLOWER_OPTIONS.toleranceCents;

  return (
    <main className={mode === "listen" || mode === "mic" ? "player playing" : "player"}>
      <header className="player-bar">
        <button className="ghost" onClick={onBack}>
          ← Bibliothèque
        </button>
        <div className="player-title">
          <strong>{entry.title}</strong>
          <span>
            {entry.composer} · Niveau {entry.level} ({LEVEL_LABELS[entry.level]})
          </span>
        </div>
        <span className="best">Record : {"★".repeat(bestStars) || "—"}</span>
      </header>

      <section className="hud">
        <div className="note-box expected">
          <small>À jouer</small>
          <b>{expectedMidi !== null && mode !== "finished" ? midiToName(expectedMidi) : "—"}</b>
        </div>
        <div className={`note-box heard ${heard === null ? "" : inTune ? "good" : "off"}`}>
          <small>J'entends</small>
          <b>{heard !== null ? midiToName(heard) : "…"}</b>
          <div className="tuner" aria-hidden>
            <span style={{ left: `${50 + Math.max(-50, Math.min(50, (cents ?? 0) / 2))}%` }} />
          </div>
        </div>
        {!pianoOnly && <Fingering midi={mode === "finished" ? null : expectedMidi} />}
        <div className="stats">
          <span>
            🎵 {Math.min(step, total)}/{total}
          </span>
          <span>🔥 {streak}</span>
          <span>❌ {wrong}</span>
        </div>
      </section>

      <div className="progress" aria-hidden>
        <span style={{ width: total ? `${(Math.min(step, total) / total) * 100}%` : 0 }} />
      </div>

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
        {!pianoOnly && (
          <label className="toggle">
            <input type="checkbox" checked={octaveTolerant} onChange={(e) => setOctaveTolerant(e.target.checked)} />
            Octave libre
          </label>
        )}
      </section>
      {micError && <p className="message error">{micError}</p>}
      {mode === "listen" && myFluteSound && !pianoOnly && <p className="sound-note">🎙️ Son : votre flûte</p>}
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

      <section className="sheet">
        {loading && !loadError && <p className="message">Préparation de la partition…</p>}
        {loadError && <p className="message error">⚠️ {loadError}</p>}
        <div ref={containerRef} />
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
