import { useEffect, useRef, useState } from "react";
import { decodeRecording, LONG_RECORDING_SEC, listenForNotes } from "../lib/audioTranscribe";
import type { CatalogEntry } from "../lib/catalog";
import { addGeneratedScore } from "../lib/importJobs";
import { INSTRUMENTS, transcribe, type HeardNote, type TranscribeInstrument, type Transcription } from "../lib/transcription";

interface Props {
  onBack: () => void;
  /** Ouvre la partition transcrite dans le lecteur. */
  onOpen: (entry: CatalogEntry) => void;
}

const METERS: [number, number][] = [[4, 4], [3, 4], [2, 4], [6, 8], [2, 2]];
const KEY_NAMES: Record<string, string> = {
  "0major": "Do majeur", "1major": "Sol majeur", "2major": "Ré majeur", "3major": "La majeur", "4major": "Mi majeur", "5major": "Si majeur", "6major": "Fa♯ majeur",
  "-1major": "Fa majeur", "-2major": "Si♭ majeur", "-3major": "Mi♭ majeur", "-4major": "La♭ majeur", "-5major": "Ré♭ majeur",
  "0minor": "La mineur", "1minor": "Mi mineur", "2minor": "Si mineur", "3minor": "Fa♯ mineur", "4minor": "Do♯ mineur", "5minor": "Sol♯ mineur", "6minor": "Ré♯ mineur",
  "-1minor": "Ré mineur", "-2minor": "Sol mineur", "-3minor": "Do mineur", "-4minor": "Fa mineur", "-5minor": "Si♭ mineur",
};
const ICONS: Record<TranscribeInstrument, string> = { flute: "🪈", violin: "🎻", piano: "🎹" };

type Phase =
  | { kind: "idle" }
  | { kind: "recording"; since: number }
  | { kind: "working"; percent: number; label: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

/**
 * Transcrire un enregistrement (fichier audio ou vidéo, ou micro) de flûte, violon ou piano en
 * partition : le modèle Basic Pitch écoute sur l'appareil, puis la partition est écrite
 * (`transcription.ts`) et ajoutée à la bibliothèque, où on peut la jouer et la corriger (✏️).
 */
export function Transcribe({ onBack, onOpen }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [instrument, setInstrument] = useState<TranscribeInstrument>("flute");
  const [meter, setMeter] = useState(0);
  const [autoTempo, setAutoTempo] = useState(true);
  const [tempo, setTempo] = useState(90);
  const [grid, setGrid] = useState<1 | 2>(1);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [source, setSource] = useState<{ name: string; url: string; seconds: number } | null>(null);
  const [heard, setHeard] = useState<{ notes: HeardNote[]; instrument: TranscribeInstrument } | null>(null);
  const [result, setResult] = useState<Transcription | null>(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const recorder = useRef<{ rec: MediaRecorder; stream: MediaStream; chunks: Blob[] } | null>(null);
  const [now, setNow] = useState(Date.now());
  // dernier enregistrement : réécouté si l'on change d'instrument (tessiture différente)
  const lastFile = useRef<{ blob: Blob; name: string } | null>(null);

  useEffect(() => {
    if (phase.kind !== "recording") return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [phase.kind]);

  useEffect(
    () => () => {
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
      if (source) URL.revokeObjectURL(source.url);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const options = (name: string) => ({
    instrument,
    title: name,
    tempo: autoTempo ? undefined : tempo,
    beats: METERS[meter][0],
    beatType: METERS[meter][1],
    grid,
  });

  /** Réécrit la partition à partir des notes déjà entendues (réglages changés), sans réécouter. */
  function rewrite(notes: HeardNote[], name: string) {
    try {
      const t = transcribe(notes, options(name));
      setResult(t);
      if (autoTempo) setTempo(t.tempo);
      setPhase({ kind: "done" });
    } catch (e) {
      setResult(null);
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function run(file: Blob, name: string) {
    lastFile.current = { blob: file, name };
    setResult(null);
    setHeard(null);
    const cleanName = name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim() || "Transcription";
    setTitle(cleanName);
    try {
      setPhase({ kind: "working", percent: 2, label: "Lecture du fichier…" });
      const { samples, seconds } = await decodeRecording(file);
      if (source) URL.revokeObjectURL(source.url);
      setSource({ name, url: URL.createObjectURL(file), seconds });
      setPhase({
        kind: "working",
        percent: 8,
        label: seconds > LONG_RECORDING_SEC ? "Enregistrement long : l'écoute peut prendre plusieurs minutes…" : "Préparation de l'écoute…",
      });
      const notes = await listenForNotes(samples, instrument, (f) =>
        setPhase({ kind: "working", percent: Math.round(10 + 85 * f), label: `Écoute des notes : ${Math.round(f * 100)} %` }),
      );
      setPhase({ kind: "working", percent: 97, label: "Écriture de la partition…" });
      setHeard({ notes, instrument });
      rewrite(notes, cleanName);
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const stamp = new Date().toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
        void run(blob, `Enregistrement du ${stamp}`);
      };
      recorder.current = { rec, stream, chunks };
      rec.start();
      setPhase({ kind: "recording", since: Date.now() });
    } catch {
      setPhase({ kind: "error", message: "Micro inaccessible : autorisez l'accès au micro pour Flûte Partitions, puis réessayez." });
    }
  }

  function stopRecording() {
    recorder.current?.rec.stop();
    recorder.current = null;
  }

  async function addToLibrary() {
    if (!result) return;
    setSaving(true);
    try {
      const xml = result.xml.replace(/<work-title>[^<]*<\/work-title>/, `<work-title>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</work-title>`);
      const { entry } = (await addGeneratedScore(xml, `${title}.musicxml`)) as { entry: CatalogEntry };
      onOpen(entry);
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  const working = phase.kind === "working" || phase.kind === "recording";
  useEffect(() => {
    if (heard && heard.instrument !== instrument && lastFile.current && phase.kind !== "working") void run(lastFile.current.blob, lastFile.current.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument]);
  // réglages changés après l'écoute : on réécrit aussitôt (même instrument)
  const settingsKey = `${meter}|${autoTempo ? "auto" : tempo}|${grid}`;
  const lastKey = useRef(settingsKey);
  useEffect(() => {
    if (lastKey.current === settingsKey) return;
    lastKey.current = settingsKey;
    if (heard && heard.instrument === instrument && phase.kind !== "working") rewrite(heard.notes, title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);

  return (
    <main className="transcribe">
      <header className="player-bar" data-tauri-drag-region>
        <button className="ghost" onClick={onBack}>
          ← Bibliothèque
        </button>
        <div className="player-title">
          <strong>🎼 Transcrire un enregistrement</strong>
          <span>Un morceau joué à la flûte, au violon ou au piano devient une partition</span>
        </div>
      </header>

      <section className="transcribe-step">
        <h2>1. L'instrument enregistré</h2>
        <div className="transcribe-choices" role="radiogroup" aria-label="Instrument">
          {(Object.keys(INSTRUMENTS) as TranscribeInstrument[]).map((k) => (
            <button key={k} role="radio" aria-checked={instrument === k} className={instrument === k ? "choice active" : "choice"} onClick={() => setInstrument(k)} disabled={working}>
              {ICONS[k]} {INSTRUMENTS[k].label}
            </button>
          ))}
        </div>
        {instrument === "violin" && <p className="transcribe-tip">Les notes trop graves pour la flûte seront écrites une octave plus haut, pour pouvoir les jouer.</p>}
      </section>

      <section className="transcribe-step">
        <h2>2. L'enregistrement</h2>
        <div className="transcribe-choices">
          <button className="primary" onClick={() => fileInput.current?.click()} disabled={working}>
            📂 Choisir un fichier audio ou vidéo
          </button>
          {phase.kind === "recording" ? (
            <button className="record active" onClick={stopRecording}>
              ⏹ Arrêter ({Math.floor((now - phase.since) / 1000)} s)
            </button>
          ) : (
            <button onClick={() => void startRecording()} disabled={working}>
              🎙️ Enregistrer au micro
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="audio/*,video/*,.mp3,.m4a,.wav,.aac,.ogg,.flac,.mp4,.mov,.webm"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void run(f, f.name);
            }}
          />
        </div>
        <p className="transcribe-tip">
          MP3, M4A, WAV, ou une vidéo (MP4, MOV) : seul le son est utilisé. Meilleur résultat avec un seul instrument, peu
          d'écho et sans accompagnement. Une vidéo YouTube ne peut pas être lue directement : utilisez un fichier que vous
          avez (par exemple votre propre enregistrement).
        </p>
      </section>

      <details className="transcribe-step" open>
        <summary>
          <h2>3. Réglages de la partition</h2>
        </summary>
        <div className="transcribe-settings">
          <label>
            Mesure
            <select value={meter} onChange={(e) => setMeter(Number(e.target.value))}>
              {METERS.map(([b, t], i) => (
                <option key={i} value={i}>
                  {b}/{t}
                </option>
              ))}
            </select>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={autoTempo} onChange={(e) => setAutoTempo(e.target.checked)} />
            Tempo trouvé automatiquement
          </label>
          {!autoTempo && (
            <label>
              ♩ =
              <input type="number" min={30} max={240} value={tempo} onChange={(e) => setTempo(Math.max(30, Math.min(240, Number(e.target.value) || 90)))} />
            </label>
          )}
          <label>
            Plus petite valeur
            <select value={grid} onChange={(e) => setGrid(Number(e.target.value) as 1 | 2)}>
              <option value={1}>double croche (précis)</option>
              <option value={2}>croche (plus simple à lire)</option>
            </select>
          </label>
        </div>
        {heard && <p className="transcribe-tip">Les réglages s'appliquent tout de suite à la partition, sans réécouter.</p>}
      </details>

      {phase.kind === "working" && (
        <div className="import-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={phase.percent}>
          <div className="import-progress-head">
            <span className="import-progress-file">🎧 {source?.name ?? title}</span>
            <strong>{phase.percent} %</strong>
          </div>
          <div className="import-progress-bar">
            <span style={{ width: `${phase.percent}%` }} />
          </div>
          <div className="import-progress-label">{phase.label}</div>
        </div>
      )}
      {phase.kind === "error" && <p className="message error">⚠️ {phase.message}</p>}

      {result && phase.kind === "done" && (
        <section className="transcribe-result">
          <h2>✅ Partition prête</h2>
          <p>
            {result.notes} notes · {result.measures} mesure{result.measures > 1 ? "s" : ""} · ♩ = {result.tempo} ·{" "}
            {KEY_NAMES[`${result.fifths}${result.mode}`] ?? "tonalité estimée"}
          </p>
          {source && <audio controls src={source.url} className="transcribe-audio" />}
          <label className="transcribe-title">
            Titre
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="transcribe-choices">
            <button className="primary" onClick={() => void addToLibrary()} disabled={saving || !title.trim()}>
              {saving ? "Ajout…" : "➕ Ajouter à la bibliothèque et ouvrir"}
            </button>
          </div>
          <p className="transcribe-tip">
            La transcription automatique n'est jamais parfaite : écoutez-la avec « 🔊 Écouter », comparez avec
            l'enregistrement, et corrigez les notes fausses avec « ✏️ Corriger des notes ». Si le rythme semble décalé,
            essayez une autre mesure ou fixez le tempo.
          </p>
        </section>
      )}
      <p className="transcribe-credit">
        Écoute des notes sur cet appareil, sans envoi : modèle Basic Pitch (Spotify, licence Apache 2.0).
      </p>
    </main>
  );
}
