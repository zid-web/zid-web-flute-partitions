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
  const ins = INSTRUMENTS[instrument];
  // seuils de Basic Pitch : attaque 0,5, tenue 0,3, note d'au moins ~90 ms, tessiture de l'instrument
  const events = outputToNotesPoly(frames, onsets, 0.5, 0.3, 8, true, ins.maxHz, ins.minHz, true);
  return noteFramesToTime(addPitchBendsToNoteEvents(contours, events)).map((n) => ({
    start: n.startTimeSeconds,
    duration: n.durationSeconds,
    midi: n.pitchMidi,
    amplitude: n.amplitude,
  }));
}
