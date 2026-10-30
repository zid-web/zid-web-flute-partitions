import { PitchDetector } from "pitchy";
import { freqToMidi } from "./notes";

/**
 * « Ma flûte » : l'application apprend le son de VOTRE flûte. Vous jouez quelques notes tenues ;
 * chaque prise est vérifiée (justesse, durée, volume), nettoyée puis gardée sur l'appareil
 * (IndexedDB, jamais envoyée). « Écouter » rejoue ensuite les partitions avec ces notes,
 * transposées de quelques demi-tons au plus pour les notes non enregistrées.
 */

/** Notes à enregistrer : une tous les 3 à 4 demi-tons, comme la flûte de référence (Do4 → La6). */
export const TARGET_NOTES = [60, 64, 69, 72, 76, 81, 84, 88, 93] as const;

/** Une note de votre flûte est utilisée jusqu'à 3 demi-tons autour d'elle. */
export const MY_FLUTE_REACH = 3;

export const TAKE_SECONDS = 5;
const MAX_KEEP_SECONDS = 6;
const TARGET_RMS = 0.12;

export interface TakeAnalysis {
  ok: boolean;
  /** Message à afficher (ce qui ne va pas, ou « Parfait »). */
  message: string;
  /** Écart de justesse moyen, en cents (+ = trop haut). */
  cents: number | null;
  /** Durée tenue exploitable, en secondes. */
  heldSeconds: number;
  /** Prise nettoyée (attaque calée au début, volume égalisé, fondu final), si `ok`. */
  pcm?: Float32Array;
}

/**
 * Analyse une prise : début du son, partie tenue à la bonne hauteur, justesse, volume.
 * Pure (aucun accès audio) : testée avec des sons synthétiques.
 */
export function analyseTake(data: Float32Array, sampleRate: number, targetMidi: number): TakeAnalysis {
  const win = 2048;
  const hop = 1024;
  const detector = PitchDetector.forFloat32Array(win);
  const frames: { start: number; rms: number; midi: number | null }[] = [];
  for (let i = 0; i + win <= data.length; i += hop) {
    const frame = data.subarray(i, i + win);
    let sum = 0;
    for (let k = 0; k < frame.length; k++) sum += frame[k] * frame[k];
    const rms = Math.sqrt(sum / win);
    const [freq, clarity] = detector.findPitch(frame, sampleRate);
    frames.push({ start: i, rms, midi: freq > 0 && clarity > 0.85 ? freqToMidi(freq) : null });
  }
  const loudest = frames.reduce((m, f) => Math.max(m, f.rms), 0);
  if (loudest < 0.01) {
    return { ok: false, message: "Je n'entends presque rien : rapprochez la flûte du micro et soufflez franchement.", cents: null, heldSeconds: 0 };
  }

  // Trames « justes » : au bon volume et à moins d'un demi-ton de la note demandée.
  const good = frames.map((f) => f.rms > loudest * 0.25 && f.midi !== null && Math.abs(f.midi - targetMidi) < 0.5);
  // Plus longue suite de trames justes (tolère une trame isolée ratée).
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < good.length; i++) {
    if (!good[i]) continue;
    let j = i;
    let misses = 0;
    while (j + 1 < good.length && (good[j + 1] || (misses++ < 1 && j + 2 < good.length && good[j + 2]))) j++;
    if (j - i + 1 > bestLen) {
      bestLen = j - i + 1;
      bestStart = i;
    }
    i = j;
  }
  const heldSeconds = (bestLen * hop) / sampleRate;

  if (bestLen === 0) {
    const heard = frames.filter((f) => f.midi !== null && f.rms > loudest * 0.25).map((f) => f.midi as number);
    if (heard.length) {
      const median = [...heard].sort((a, b) => a - b)[heard.length >> 1];
      const diff = Math.round(median - targetMidi);
      const way = diff > 0 ? "trop haut" : "trop bas";
      const octave = Math.abs(diff) === 12 ? " (une octave)" : ` (${Math.abs(diff)} demi-ton${Math.abs(diff) > 1 ? "s" : ""})`;
      return { ok: false, message: `Ce n'est pas la bonne note : ${way}${octave}. Vérifiez le doigté.`, cents: null, heldSeconds: 0 };
    }
    return { ok: false, message: "Son trop soufflé ou instable : je n'arrive pas à reconnaître la note.", cents: null, heldSeconds: 0 };
  }

  const held = frames.slice(bestStart, bestStart + bestLen).filter((f) => f.midi !== null);
  const cents = Math.round((held.reduce((s, f) => s + (f.midi as number), 0) / held.length - targetMidi) * 100);
  if (heldSeconds < 1.5) {
    return { ok: false, message: `Note tenue trop courte (${heldSeconds.toFixed(1)} s) : tenez-la au moins 2 secondes.`, cents, heldSeconds };
  }
  if (Math.abs(cents) > 30) {
    return { ok: false, message: `Note ${cents > 0 ? "trop haute" : "trop basse"} de ${Math.abs(cents)} cents : ajustez puis recommencez.`, cents, heldSeconds };
  }

  // Prise nettoyée : de l'attaque (un peu avant la partie juste) jusqu'à la fin de la tenue.
  const onsetFrame = Math.max(0, frames.findIndex((f) => f.rms > loudest * 0.1));
  const from = Math.max(0, Math.min(frames[onsetFrame].start, frames[bestStart].start) - Math.floor(0.01 * sampleRate));
  const to = Math.min(data.length, frames[bestStart + bestLen - 1].start + win, from + Math.floor(MAX_KEEP_SECONDS * sampleRate));
  const pcm = data.slice(from, to);
  const body = pcm.subarray(Math.min(pcm.length - 1, Math.floor(0.3 * sampleRate)));
  let sum = 0;
  for (let k = 0; k < body.length; k++) sum += body[k] * body[k];
  const gain = TARGET_RMS / Math.max(Math.sqrt(sum / Math.max(1, body.length)), 1e-6);
  const fade = Math.min(pcm.length, Math.floor(0.3 * sampleRate));
  for (let k = 0; k < pcm.length; k++) {
    const f = k >= pcm.length - fade ? (pcm.length - k) / fade : 1;
    pcm[k] = Math.max(-0.98, Math.min(0.98, pcm[k] * gain * f));
  }
  const message = Math.abs(cents) <= 10 ? "Parfait, note juste !" : `Bien : légèrement ${cents > 0 ? "haute" : "basse"} (${Math.abs(cents)} cents), corrigé à la lecture.`;
  return { ok: true, message, cents, heldSeconds, pcm };
}

// --- Stockage sur l'appareil ------------------------------------------------

export interface StoredTake {
  midi: number;
  sampleRate: number;
  pcm: Float32Array;
  /** Écart de justesse mesuré : corrigé à la lecture. */
  cents: number;
  recordedAt: number;
}

const DB_NAME = "flute-ma-flute";
const STORE = "takes";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "midi" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Stockage local indisponible."));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("Erreur du stockage local."));
    });
  } finally {
    db.close();
  }
}

export async function listTakes(): Promise<StoredTake[]> {
  try {
    return (await run<StoredTake[]>("readonly", (s) => s.getAll())).sort((a, b) => a.midi - b.midi);
  } catch {
    return [];
  }
}

export async function saveTake(take: StoredTake): Promise<void> {
  await run("readwrite", (s) => s.put(take));
}

export async function deleteTake(midi: number): Promise<void> {
  await run("readwrite", (s) => s.delete(midi));
}

// --- Préférence : jouer avec ma flûte ----------------------------------------

const PREF = "flute-partitions:ma-flute";

export function isMyFluteEnabled(): boolean {
  try {
    return localStorage.getItem(PREF) !== "non";
  } catch {
    return true;
  }
}

export function setMyFluteEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF, on ? "oui" : "non");
  } catch {
    // préférence non mémorisée
  }
}

// --- Enregistrement au micro --------------------------------------------------

/**
 * Enregistre `seconds` secondes au micro, sans traitement (pas d'annulation d'écho ni de
 * réduction de bruit, qui abîment le timbre). `onLevel` reçoit le volume pour l'afficher.
 */
export async function recordTake(seconds: number, onLevel?: (level: number) => void): Promise<{ data: Float32Array; sampleRate: number }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const ctx = new AudioContext();
  try {
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const total = Math.floor(seconds * ctx.sampleRate);
    const data = new Float32Array(total);
    let filled = 0;
    await new Promise<void>((resolve) => {
      proc.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const n = Math.min(input.length, total - filled);
        data.set(input.subarray(0, n), filled);
        filled += n;
        if (onLevel) {
          let sum = 0;
          for (let k = 0; k < input.length; k++) sum += input[k] * input[k];
          onLevel(Math.sqrt(sum / input.length));
        }
        if (filled >= total) resolve();
      };
      source.connect(proc);
      proc.connect(ctx.destination); // nécessaire pour que le traitement tourne (sortie silencieuse)
    });
    proc.disconnect();
    source.disconnect();
    return { data, sampleRate: ctx.sampleRate };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  }
}
