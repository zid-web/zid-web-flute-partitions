import { useEffect, useRef, useState } from "react";
import { fingeringFor } from "../lib/fingering";
import { centsOff, midiToFreq, midiToName } from "../lib/notes";
import { MicPitchSource, type PitchReading } from "../lib/pitch";
import { FluteSynth } from "../lib/synth";
import { Fingering } from "./Fingering";

interface NotePreset {
  midi: number;
  label: string;
}

const COMMON_NOTES: NotePreset[] = [
  { midi: 60, label: "Do₄" },
  { midi: 62, label: "Ré₄" },
  { midi: 64, label: "Mi₄" },
  { midi: 65, label: "Fa₄" },
  { midi: 67, label: "Sol₄" },
  { midi: 69, label: "La₄" },
  { midi: 71, label: "Si₄" },
  { midi: 72, label: "Do₅" },
  { midi: 74, label: "Ré₅" },
  { midi: 76, label: "Mi₅" },
  { midi: 77, label: "Fa₅" },
  { midi: 79, label: "Sol₅" },
  { midi: 81, label: "La₅" },
  { midi: 83, label: "Si₅" },
  { midi: 84, label: "Do₆" },
];

export function FluteExplorer({ onClose }: { onClose?: () => void }) {
  const [selectedMidi, setSelectedMidi] = useState<number>(67); // Sol4 par défaut
  const [isPlaying, setIsPlaying] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [micReading, setMicReading] = useState<PitchReading | null>(null);
  const [micError, setMicError] = useState<string | null>(null);

  const synthRef = useRef<FluteSynth | null>(null);
  const micSourceRef = useRef<MicPitchSource | null>(null);

  // Initialisation paresseuse du synthé audio au clic
  function getSynth(): FluteSynth {
    if (!synthRef.current) {
      synthRef.current = new FluteSynth();
    }
    return synthRef.current;
  }

  // Joue la note sélectionnée
  function playNote(midi: number) {
    setSelectedMidi(midi);
    setIsPlaying(true);
    try {
      const synth = getSynth();
      synth.play(midi, 0.85);
      setTimeout(() => setIsPlaying(false), 850);
    } catch {
      setIsPlaying(false);
    }
  }

  // Gestion du micro en mode accordeur
  async function toggleMic() {
    if (micActive) {
      micSourceRef.current?.stop();
      micSourceRef.current = null;
      setMicActive(false);
      setMicReading(null);
      return;
    }

    setMicError(null);
    try {
      const source = new MicPitchSource((reading) => {
        setMicReading(reading);
        if (reading.midi !== null) {
          const rounded = Math.round(reading.midi);
          if (fingeringFor(rounded) !== null) {
            setSelectedMidi(rounded);
          }
        }
      });
      await source.start();
      micSourceRef.current = source;
      setMicActive(true);
    } catch (err) {
      setMicError(err instanceof Error ? err.message : "Accès au micro refusé.");
      setMicActive(false);
    }
  }

  useEffect(() => {
    return () => {
      micSourceRef.current?.stop();
      synthRef.current?.close();
    };
  }, []);

  const freq = Math.round(midiToFreq(selectedMidi) * 10) / 10;
  const noteName = midiToName(selectedMidi);

  // Accordeur live
  const cents = micReading && micReading.midi !== null ? Math.round(centsOff(micReading.midi, selectedMidi)) : null;
  const isTuned = cents !== null && Math.abs(cents) <= 8;

  return (
    <section className="flute-explorer" aria-label="Espace interactif de découverte des sons et doigtés">
      <div className="explorer-card">
        <div className="explorer-header">
          <div className="explorer-title-area">
            <span className="explorer-icon">🎵</span>
            <div>
              <h3>Laboratoire de Sons & Doigtés de Flûte</h3>
              <p>Cliquez sur une note pour l'écouter et observer le doigté, ou activez le micro pour accorder votre instrument.</p>
            </div>
          </div>
          <div className="explorer-header-actions">
            <button
              className={`chip ${micActive ? "active-mic" : ""}`}
              onClick={toggleMic}
              title={micActive ? "Désactiver le micro" : "Activer le micro pour tester en direct"}
            >
              {micActive ? "🔴 Arrêter l'écoute" : "🎤 Tester mon micro"}
            </button>
            {onClose && (
              <button className="ghost close-btn" onClick={onClose} aria-label="Fermer l'espace découverte">
                ✕
              </button>
            )}
          </div>
        </div>

        {micError && <p className="message error">⚠️ {micError}</p>}

        {micActive && (
          <div className="tuner-banner">
            <div className="tuner-status">
              <span>🎤 Détection en direct :</span>
              <strong>{micReading && micReading.midi !== null ? midiToName(micReading.midi) : "En attente d'un son..."}</strong>
              {cents !== null && (
                <span className={`tuner-cents ${isTuned ? "tuned" : cents > 0 ? "sharp" : "flat"}`}>
                  {cents > 0 ? `+${cents} cents (trop haut)` : cents < 0 ? `${cents} cents (trop bas)` : "Parfaitement juste !"}
                </span>
              )}
            </div>
            <div className="tuner-gauge" aria-hidden="true">
              <div className="tuner-center" />
              <div
                className="tuner-indicator"
                style={{
                  left: `${Math.max(5, Math.min(95, 50 + (cents ?? 0)))}%`,
                  backgroundColor: isTuned ? "#10b981" : "#f59e0b",
                }}
              />
            </div>
          </div>
        )}

        <div className="explorer-body">
          {/* Grille de sélection des notes */}
          <div className="notes-palette">
            <span className="palette-label">Sélectionnez une note :</span>
            <div className="notes-btn-grid" role="group" aria-label="Gammes de flûte">
              {COMMON_NOTES.map((n) => {
                const active = selectedMidi === n.midi;
                return (
                  <button
                    key={n.midi}
                    className={`note-preset-btn ${active ? "active" : ""}`}
                    onClick={() => playNote(n.midi)}
                  >
                    <span className="btn-note-label">{n.label}</span>
                    <span className="btn-note-freq">{Math.round(midiToFreq(n.midi))} Hz</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Affichage du doigté et des caractéristiques */}
          <div className="fingering-display-panel">
            <div className="note-card-meta">
              <div className="note-big-badge">
                <span className="note-solfege">{noteName}</span>
                <span className="note-frequency">{freq} Hz</span>
              </div>
              <div className="note-advice">
                <strong>Clés & Registre</strong>
                <span>
                  {selectedMidi < 72
                    ? "1ʳᵉ octave : colonne d'air ample et souple, lèvres détendues."
                    : selectedMidi < 84
                    ? "2ᵉ octave : filet d'air plus rapide et plus étroit."
                    : "3ᵉ octave : harmonique supérieure, filet d'air tonique."}
                </span>
                <button
                  className="primary play-note-cta"
                  disabled={isPlaying}
                  onClick={() => playNote(selectedMidi)}
                >
                  🔊 {isPlaying ? "Écoute..." : "Faire sonner la flûte"}
                </button>
              </div>
            </div>

            <div className="interactive-fingering-wrap">
              <Fingering midi={selectedMidi} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
