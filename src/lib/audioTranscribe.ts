import { INSTRUMENTS, type HeardNote, type TranscribeInstrument } from "./transcription";

/**
 * Écoute d'un enregistrement (audio, ou piste son d'une vidéo) par le modèle Basic Pitch
 * (Spotify, Apache 2.0 — public/models/basic-pitch/), sur l'appareil : rien n'est envoyé, et
 * cela fonctionne hors ligne. Le modèle et TensorFlow.js ne sont chargés qu'à la première
 * transcription.
 */

const MODEL_RATE = 22050;
/** Au-delà, l'analyse devient très longue : on prévient. */
export const LONG_RECORDING_SEC = 8 * 60;

export interface ListenProgress {
  /** 0 → 1 */
  fraction: number;
  label: string;
}

/** Décode le fichier (mp3, m4a, wav, ogg, flac, mp4, mov, webm…) en son mono à 22 050 Hz. */
export async function decodeRecording(file: Blob): Promise<{ samples: Float32Array; seconds: number }> {
  const data = await file.arrayBuffer();
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(data);
  } catch {
    throw new Error(
      "Ce fichier ne peut pas être lu (format non reconnu, ou vidéo sans son). Essayez un fichier MP3, M4A ou WAV, ou une vidéo MP4.",
    );
  } finally {
    void ctx.close().catch(() => {});
  }
  const length = Math.max(1, Math.ceil(decoded.duration * MODEL_RATE));
  const offline = new OfflineAudioContext(1, length, MODEL_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return { samples: rendered.getChannelData(0), seconds: decoded.duration };
}

/** Notes entendues dans l'enregistrement (Basic Pitch), réglées pour l'instrument. */
export async function listenForNotes(
  samples: Float32Array,
  instrument: TranscribeInstrument,
  onProgress: (fraction: number) => void,
): Promise<HeardNote[]> {
  const { BasicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime } = await import("@spotify/basic-pitch");
  const model = new BasicPitch(`${import.meta.env.BASE_URL}models/basic-pitch/model.json`);
  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];
  await model.evaluateModel(
    samples,
    (f, o, c) => {
      for (const x of f) frames.push(x);
      for (const x of o) onsets.push(x);
      for (const x of c) contours.push(x);
    },
    onProgress,
  );
  // seuils de Basic Pitch : attaque 0,5, tenue 0,3, note d'au moins ~90 ms ; toute la tessiture :
  // l'accompagnement (basses, accords) sert à trouver la pulsation et le premier temps, seul
  // l'instrument choisi est écrit (transcription.ts)
  void INSTRUMENTS[instrument];
  const events = outputToNotesPoly(frames, onsets, 0.5, 0.3, 8, true, null, null, true);
  const env = volumeEnvelope(samples);
  return noteFramesToTime(addPitchBendsToNoteEvents(contours, events)).map((n) => ({
    start: n.startTimeSeconds,
    duration: n.durationSeconds,
    midi: n.pitchMidi,
    amplitude: n.amplitude,
    dip: attackDip(env, n.startTimeSeconds),
  }));
}

const ENV_HOP = 0.01; // secondes

/** Volume (moyenne quadratique) toutes les 10 ms. */
export function volumeEnvelope(samples: Float32Array, rate = MODEL_RATE): Float32Array {
  const hop = Math.round(rate * ENV_HOP);
  const env = new Float32Array(Math.ceil(samples.length / hop));
  for (let k = 0; k < env.length; k++) {
    let sum = 0;
    const end = Math.min(samples.length, (k + 1) * hop);
    for (let i = k * hop; i < end; i++) sum += samples[i] * samples[i];
    env[k] = Math.sqrt(sum / Math.max(1, end - k * hop));
  }
  return env;
}

/** Creux de volume avant une attaque : volume minimal juste avant / volume maximal juste après. */
export function attackDip(env: Float32Array, start: number): number {
  const at = Math.round(start / ENV_HOP);
  let before = Infinity;
  for (let k = Math.max(0, at - 8); k <= Math.max(0, at - 1); k++) before = Math.min(before, env[k] ?? Infinity);
  let after = 0;
  for (let k = at; k < Math.min(env.length, at + 6); k++) after = Math.max(after, env[k]);
  if (!Number.isFinite(before) || after <= 0) return 0;
  return Math.min(1, before / after);
}
