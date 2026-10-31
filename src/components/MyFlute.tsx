import { useCallback, useEffect, useRef, useState } from "react";
import {
  analyseTake,
  deleteTake,
  isMyFluteEnabled,
  listTakes,
  recordTake,
  saveTake,
  setMyFluteEnabled,
  isMyFluteOnly,
  setMyFluteOnly,
  TAKE_SECONDS,
  TARGET_NOTES,
  type StoredTake,
} from "../lib/myFlute";
import { midiToName } from "../lib/notes";
import { requestPersistentStorage } from "../lib/userScores";
import { Fingering } from "./Fingering";

const dateFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

interface Props {
  onBack: () => void;
  /** Sauvegarde (partitions importées + notes) ; renvoie le message à afficher, ou null si annulée. */
  onBackup: () => Promise<string | null>;
  /** Restaure un fichier de sauvegarde ; renvoie le message à afficher. */
  onRestore: (file: File) => Promise<string>;
}

/** « Ma flûte » : enregistrer quelques notes pour que « Écouter » joue avec le son de votre flûte. */
export function MyFlute({ onBack, onBackup, onRestore }: Props) {
  const restoreInput = useRef<HTMLInputElement>(null);
  const [backupMessage, setBackupMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [takes, setTakes] = useState<StoredTake[]>([]);
  const [busy, setBusy] = useState<{ midi: number; phase: "countdown" | "recording"; count: number } | null>(null);
  const [level, setLevel] = useState(0);
  const [results, setResults] = useState<Record<number, { ok: boolean; text: string } | undefined>>({});
  const [enabled, setEnabled] = useState(isMyFluteEnabled);
  const [only, setOnly] = useState(isMyFluteOnly);
  const [error, setError] = useState<string | null>(null);
  const playCtx = useRef<AudioContext | null>(null);

  const refresh = useCallback(() => listTakes().then(setTakes), []);
  useEffect(() => {
    void refresh();
    return () => void playCtx.current?.close();
  }, [refresh]);

  async function record(midi: number) {
    setError(null);
    setResults((r) => ({ ...r, [midi]: undefined }));
    for (let n = 3; n > 0; n--) {
      setBusy({ midi, phase: "countdown", count: n });
      await new Promise((r) => setTimeout(r, 800));
    }
    setBusy({ midi, phase: "recording", count: TAKE_SECONDS });
    try {
      const { data, sampleRate } = await recordTake(TAKE_SECONDS, setLevel);
      const a = analyseTake(data, sampleRate, midi);
      if (a.ok && a.pcm) {
        await saveTake({ midi, sampleRate, pcm: a.pcm, cents: a.cents ?? 0, recordedAt: Date.now() });
        void requestPersistentStorage();
        await refresh();
      }
      setResults((r) => ({ ...r, [midi]: { ok: a.ok, text: a.message } }));
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Accès au micro refusé : autorisez le micro dans les réglages pour enregistrer votre flûte."
          : "Micro indisponible sur cet appareil.",
      );
    } finally {
      setBusy(null);
      setLevel(0);
    }
  }

  function listen(take: StoredTake) {
    const ctx = (playCtx.current ??= new AudioContext());
    void ctx.resume();
    const buffer = ctx.createBuffer(1, take.pcm.length, take.sampleRate);
    buffer.copyToChannel(new Float32Array(take.pcm), 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start();
  }

  async function remove(midi: number) {
    if (!window.confirm(`Supprimer votre enregistrement du ${midiToName(midi)} ?`)) return;
    await deleteTake(midi);
    setResults((r) => ({ ...r, [midi]: undefined }));
    await refresh();
  }

  const recorded = new Map(takes.map((t) => [t.midi, t]));

  return (
    <main className="player my-flute">
      <header className="player-bar">
        <button className="ghost" onClick={onBack} disabled={busy !== null}>
          ← Bibliothèque
        </button>
        <div className="player-title">
          <strong>🎙️ Ma flûte</strong>
          <span>
            {recorded.size} / {TARGET_NOTES.length} notes enregistrées
          </span>
        </div>
      </header>

      <section className="my-flute-intro">
        <p>
          Apprenez à l'application le son de <b>votre</b> flûte : jouez chaque note bien tenue, pendant {TAKE_SECONDS}{" "}
          secondes, dans une pièce calme, à 30–50 cm du micro. Ensuite, <b>🔊 Écouter</b> joue toutes les partitions avec
          votre son : chaque note de la partition est jouée à partir de la note enregistrée la plus proche. Plus
          vous enregistrez de notes, plus le son est naturel.
        </p>
        <p className="muted">
          Les enregistrements sont gardés dans l'application, sur cet appareil (ils ne sont envoyés nulle part) : ils
          restent après les mises à jour. Pour les retrouver après une réinstallation ou sur un autre appareil, utilisez{" "}
          <b>💾 Sauvegarder mes notes</b> ci-dessous, puis <b>♻️ Restaurer</b>.
        </p>
        <label className="toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              setMyFluteEnabled(e.target.checked);
            }}
          />
          Utiliser ma flûte pour « Écouter »
        </label>
        <label className="toggle" title="Sinon, les notes éloignées de vos enregistrements (plus de 3 demi-tons) sont jouées par la flûte de référence">
          <input
            type="checkbox"
            checked={only}
            disabled={!enabled}
            onChange={(e) => {
              setOnly(e.target.checked);
              setMyFluteOnly(e.target.checked);
            }}
          />
          Uniquement ma flûte (jamais la flûte de référence)
        </label>
        <div className="backup">
          <button
            className="ghost"
            disabled={busy !== null || takes.length === 0}
            title="Enregistrer une copie de vos notes (et de vos partitions importées), à garder en lieu sûr"
            onClick={() => {
              setBackupMessage(null);
              onBackup().then(
                (text) => text && setBackupMessage({ text: `✅ ${text}` }),
                (e: unknown) =>
                  setBackupMessage({ text: `Sauvegarde impossible : ${e instanceof Error ? e.message : String(e)}`, error: true }),
              );
            }}
          >
            💾 Sauvegarder mes notes
          </button>
          <button className="ghost" disabled={busy !== null} onClick={() => restoreInput.current?.click()}>
            ♻️ Restaurer
          </button>
          <input
            ref={restoreInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              onRestore(file).then(
                async (text) => {
                  setBackupMessage({ text });
                  await refresh();
                },
                (err: Error) => setBackupMessage({ text: err.message, error: true }),
              );
            }}
          />
        </div>
        {backupMessage && (
          <p className={backupMessage.error ? "message error" : "muted"} role="status">
            {backupMessage.text}
          </p>
        )}
        {error && <p className="message error">{error}</p>}
      </section>

      <ul className="cards take-list">
        {TARGET_NOTES.map((midi) => {
          const take = recorded.get(midi);
          const result = results[midi];
          const mine = busy?.midi === midi;
          return (
            <li key={midi} className={`card take${take ? " done" : ""}`}>
              <div className="take-head">
                <strong className="title">{midiToName(midi)}</strong>
                <span className="take-status">
                  {take ? `✅ enregistrée le ${dateFormat.format(take.recordedAt)}` : "à enregistrer"}
                </span>
              </div>
              <Fingering midi={midi} />
              {mine && busy.phase === "countdown" && <p className="take-live">Préparez-vous… {busy.count}</p>}
              {mine && busy.phase === "recording" && (
                <div className="take-live" aria-live="polite">
                  🔴 Jouez le {midiToName(midi)} et tenez-le…
                  <span className="level-meter" aria-hidden>
                    <span style={{ width: `${Math.min(100, level * 400)}%` }} />
                  </span>
                </div>
              )}
              {result && <p className={result.ok ? "take-result ok" : "take-result bad"}>{result.text}</p>}
              <div className="controls">
                <button className={take ? "" : "primary"} disabled={busy !== null} onClick={() => void record(midi)}>
                  🎙️ {take ? "Recommencer" : "Enregistrer"}
                </button>
                {take && (
                  <>
                    <button disabled={busy !== null} onClick={() => listen(take)}>
                      ▶ Écouter
                    </button>
                    <button className="ghost" disabled={busy !== null} onClick={() => void remove(midi)} aria-label={`Supprimer le ${midiToName(midi)}`}>
                      ✕
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
