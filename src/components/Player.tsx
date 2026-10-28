import { useCallback, useEffect, useRef, useState } from "react";
import { LEVEL_LABELS, loadScoreXml, type CatalogEntry } from "../lib/catalog";
import { DEFAULT_FOLLOWER_OPTIONS, ScoreFollower, starsFor, type FollowerEvent } from "../lib/follower";
import { centsOff, midiToName } from "../lib/notes";
import { MicPitchSource } from "../lib/pitch";
import { recordResult, type PieceProgress } from "../lib/progress";
import { COLORS, ScoreController } from "../lib/score";
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
  const synthRef = useRef<FluteSynth | null>(null);
  const timersRef = useRef<number[]>([]);

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
  const [tempo, setTempo] = useState(72);
  const [octaveTolerant, setOctaveTolerant] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

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
      .then((xml) => controller.load(xml))
      .then(() => {
        if (cancelled) return;
        followerRef.current = new ScoreFollower(
          controller.steps.map((s) => s.midi),
          DEFAULT_FOLLOWER_OPTIONS,
        );
        setTotal(controller.steps.length);
        const bpm = controller.osmd.Sheet?.DefaultStartTempoInBpm;
        if (bpm && bpm >= 40 && bpm <= 140) setTempo(Math.round(bpm));
        setLoading(false);
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
      micRef.current?.stop();
      synthRef.current?.close();
      timersRef.current.forEach(clearTimeout);
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
    synthRef.current?.stop();
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

  const startMic = useCallback(async () => {
    restart();
    setMicError(null);
    const mic = new MicPitchSource((r) => {
      setHeard(r.midi);
      const follower = followerRef.current;
      if (follower) handleEvents(follower.push({ midi: r.midi, timeMs: r.timeMs, level: r.level }));
    });
    try {
      await mic.start();
      micRef.current = mic;
      setMode("mic");
    } catch (e) {
      setMicError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Accès au micro refusé. Autorisez le micro dans les réglages pour jouer."
          : "Micro indisponible sur cet appareil.",
      );
    }
  }, [handleEvents, restart]);

  /** Mode Écouter : l'application joue le morceau et la partition défile. */
  const startListen = useCallback(async () => {
    restart();
    const score = scoreRef.current;
    if (!score) return;
    const synth = (synthRef.current ??= new FluteSynth());
    await synth.resume();
    setMode("listen");
    const secPerBeat = 60 / tempo;
    // Le son est programmé sur l'horloge audio (rythme exact) ; l'affichage suit avec des minuteries.
    const t0 = synth.schedule(
      score.steps.map((s) => ({ midi: s.midi, start: s.startBeat * secPerBeat, duration: s.beats * secPerBeat })),
    );
    const offsetMs = Math.max(0, (t0 - synth.ctx.currentTime) * 1000);
    score.steps.forEach((s, i) => {
      const t = window.setTimeout(() => {
        if (i > 0) score.color(i - 1, COLORS.hit);
        score.goToStep(i);
        setStep(i);
        setHeard(s.midi);
      }, offsetMs + s.startBeat * secPerBeat * 1000);
      timersRef.current.push(t);
    });
    const last = score.steps.at(-1);
    if (last) {
      const end = window.setTimeout(
        () => {
          score.resetColors();
          score.goToStep(0);
          setStep(0);
          setHeard(null);
          setMode("idle");
        },
        offsetMs + (last.startBeat + last.beats) * secPerBeat * 1000 + 300,
      );
      timersRef.current.push(end);
    }
  }, [restart, tempo]);

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
    <main className="player">
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
        <Fingering midi={mode === "finished" ? null : expectedMidi} />
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
        {mode === "mic" ? (
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
        <button onClick={skipNote} disabled={loading || mode === "listen" || mode === "finished"}>
          ⏭ Note suivante
        </button>
        <button onClick={restart} disabled={loading}>
          ↺ Recommencer
        </button>
        <label className="slider">
          Tempo {tempo}
          <input type="range" min={40} max={140} value={tempo} onChange={(e) => setTempo(Number(e.target.value))} />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={octaveTolerant} onChange={(e) => setOctaveTolerant(e.target.checked)} />
          Octave libre
        </label>
      </section>
      {micError && <p className="message error">{micError}</p>}
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
