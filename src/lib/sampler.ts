import { MY_FLUTE_REACH, type StoredTake } from "./myFlute";
import type { ScheduledNote } from "./synth";

/**
 * Vraie flûte traversière pour le mode « Écouter » : enregistrements note par note
 * (VSCO-2 Community Edition, CC0 — voir public/samples/flute/CREDITS.txt), embarqués dans
 * l'application (hors ligne). Un enregistrement tous les 3 à 4 demi-tons, du Do4 au Do7 :
 * chaque note est jouée depuis le plus proche, transposé de 2 demi-tons au plus.
 * Une note plus longue que l'enregistrement est prolongée par des fondus enchaînés.
 */

/** Interface commune au synthétiseur et à la flûte échantillonnée. */
export interface FlutePlayer {
  readonly ctx: BaseAudioContext;
  resume(): Promise<void>;
  /** Programme une mélodie ; renvoie l'heure audio du départ. */
  schedule(notes: ScheduledNote[], lead?: number): number;
  play(midi: number, durationSec: number): void;
  stop(): void;
  close(): void;
}

/** Enregistrement à utiliser pour une note, et vitesse de lecture (transposition). */
export function pickSample(midi: number, available: number[]): { sample: number; rate: number } {
  const sample = available.reduce((best, s) => {
    const d = Math.abs(s - midi) - Math.abs(best - midi);
    // à égalité, l'enregistrement du dessus (descendre un peu le son reste plus naturel)
    return d < 0 || (d === 0 && s > best) ? s : best;
  });
  return { sample, rate: Math.pow(2, (midi - sample) / 12) };
}

/**
 * Fin de la partie tenue d'un enregistrement (secondes) : après, le son s'éteint (fin du souffle,
 * fondu). On ne s'en sert pas pour prolonger une note. Repère : dernier instant où le volume
 * (par fenêtres de 50 ms) vaut encore 70 % du volume médian.
 */
export function sustainEnd(data: Float32Array, sampleRate: number): number {
  const win = Math.max(1, Math.floor(sampleRate * 0.05));
  const rms: number[] = [];
  for (let i = 0; i + win <= data.length; i += win) {
    let sum = 0;
    for (let k = i; k < i + win; k++) sum += data[k] * data[k];
    rms.push(Math.sqrt(sum / win));
  }
  if (rms.length === 0) return 0;
  const median = [...rms].sort((a, b) => a - b)[rms.length >> 1];
  let last = rms.length - 1;
  while (last > 0 && rms[last] < median * 0.7) last--;
  return (last * win) / sampleRate;
}

/**
 * « Ma flûte » d'abord : une note enregistrée par l'utilisateur à 3 demi-tons au plus ;
 * sinon la flûte de référence.
 */
export function chooseSource(midi: number, mine: number[], reference: number[]): { mine: boolean; sample: number } {
  if (mine.length) {
    const { sample } = pickSample(midi, mine);
    if (Math.abs(sample - midi) <= MY_FLUTE_REACH) return { mine: true, sample };
  }
  return { mine: false, sample: pickSample(midi, reference).sample };
}

/** Volume selon le registre : la flûte est douce dans le grave et plus brillante dans l'aigu. */
export function sampleGain(midi: number): number {
  return 0.85 + 0.35 * Math.min(1, Math.max(0, (midi - 60) / 30));
}

const LOOP_FROM = 1.2; // reprise après l'attaque, pour prolonger une note longue
const CROSSFADE = 0.25;

export class SampledFlute implements FlutePlayer {
  readonly ctx: BaseAudioContext;
  private output: AudioNode;
  private reverbIn: AudioNode;
  private bus: GainNode;
  private notes: number[];
  private ends = new Map<AudioBuffer, number>();
  private mine = new Map<number, { buffer: AudioBuffer; cents: number }>();
  private myNotes: number[] = [];

  private constructor(ctx: BaseAudioContext, private buffers: Map<number, AudioBuffer>, takes: StoredTake[]) {
    this.ctx = ctx;
    this.notes = [...buffers.keys()].sort((a, b) => a - b);
    for (const take of takes) {
      const buffer = ctx.createBuffer(1, take.pcm.length, take.sampleRate);
      buffer.copyToChannel(new Float32Array(take.pcm), 0);
      this.mine.set(take.midi, { buffer, cents: take.cents });
    }
    this.myNotes = [...this.mine.keys()].sort((a, b) => a - b);
    for (const buffer of [...buffers.values(), ...[...this.mine.values()].map((m) => m.buffer)]) {
      this.ends.set(buffer, sustainEnd(buffer.getChannelData(0), buffer.sampleRate));
    }
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.ratio.value = 2.5;
    compressor.connect(ctx.destination);
    this.output = compressor;
    // Un peu de salle : les enregistrements sont assez secs.
    const reverb = ctx.createConvolver();
    reverb.buffer = roomImpulse(ctx, 1.4);
    const wet = ctx.createGain();
    wet.gain.value = 0.16;
    reverb.connect(wet).connect(compressor);
    this.reverbIn = reverb;
    this.bus = this.newBus();
  }

  /** Vrai si au moins une note de « Ma flûte » est utilisée. */
  get usesMyFlute(): boolean {
    return this.myNotes.length > 0;
  }

  /**
   * Charge les enregistrements de référence (depuis le cache hors ligne après la première visite)
   * et, s'il y en a, les notes de « Ma flûte » enregistrées sur l'appareil.
   */
  static async load(
    ctx: BaseAudioContext = new AudioContext({ latencyHint: "playback" }),
    baseUrl = import.meta.env.BASE_URL,
    takes: StoredTake[] = [],
  ) {
    const dir = `${baseUrl}samples/flute/`;
    const notes = (await (await fetch(`${dir}notes.json`)).json()) as number[];
    const entries = await Promise.all(
      notes.map(async (midi) => {
        const res = await fetch(`${dir}flute-${midi}.mp3`);
        if (!res.ok) throw new Error(`Échantillon de flûte manquant (${midi})`);
        return [midi, await ctx.decodeAudioData(await res.arrayBuffer())] as const;
      }),
    );
    return new SampledFlute(ctx, new Map(entries), takes);
  }

  async resume(): Promise<void> {
    if (this.ctx instanceof AudioContext && this.ctx.state === "suspended") await this.ctx.resume();
  }

  schedule(notes: ScheduledNote[], lead = 0.12): number {
    const t0 = this.ctx.currentTime + lead;
    notes.forEach((n, i) => {
      const next = notes[i + 1];
      const legato = next !== undefined && Math.abs(next.start - (n.start + n.duration)) < 0.01;
      const previousTied = i > 0 && Math.abs(notes[i - 1].start + notes[i - 1].duration - n.start) < 0.01;
      this.note(n.midi, t0 + n.start, n.duration, legato, previousTied);
    });
    return t0;
  }

  play(midi: number, durationSec: number): void {
    this.note(midi, this.ctx.currentTime + 0.02, durationSec, false, false);
  }

  stop(): void {
    const old = this.bus;
    const now = this.ctx.currentTime;
    old.gain.cancelScheduledValues(now);
    old.gain.setValueAtTime(old.gain.value, now);
    old.gain.linearRampToValueAtTime(0, now + 0.06);
    setTimeout(() => old.disconnect(), 250);
    this.bus = this.newBus();
  }

  close(): void {
    if (this.ctx instanceof AudioContext) void this.ctx.close();
  }

  private newBus(): GainNode {
    const bus = this.ctx.createGain();
    bus.connect(this.output);
    bus.connect(this.reverbIn);
    return bus;
  }

  /**
   * `legato` : la note suivante enchaîne sans silence (on ne détache presque pas) ;
   * `slurredIn` : la précédente enchaînait, on entre sans la petite attaque soufflée.
   */
  private note(midi: number, t: number, written: number, legato: boolean, slurredIn: boolean): void {
    const source = chooseSource(midi, this.myNotes, this.notes);
    const mine = source.mine ? this.mine.get(source.sample) : undefined;
    const buffer = mine?.buffer ?? this.buffers.get(source.sample);
    if (!buffer) return;
    // transposition, et correction de la justesse mesurée à l'enregistrement de « Ma flûte »
    const rate = Math.pow(2, (midi - source.sample - (mine?.cents ?? 0) / 100) / 12);
    const sounding = Math.max(0.08, written * (legato ? 0.98 : 0.9));
    const end = t + sounding;
    const level = sampleGain(midi);
    const held = this.ends.get(buffer) ?? buffer.duration;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(level, t + (slurredIn ? 0.03 : 0.012));
    env.gain.setTargetAtTime(0, end, legato ? 0.03 : 0.045);
    env.connect(this.bus);

    // Morceaux successifs de l'enregistrement, en fondu enchaîné, jusqu'à couvrir la note.
    let start = t;
    let offset = slurredIn ? 0.05 : 0; // en legato, on saute le début de l'attaque
    let first = true;
    while (start < end + 0.2) {
      const usable = (held - offset) / rate; // secondes de son tenu utilisables
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      const fade = this.ctx.createGain();
      const segEnd = start + usable;
      fade.gain.setValueAtTime(first ? 1 : 0, start);
      if (!first) fade.gain.linearRampToValueAtTime(1, start + CROSSFADE);
      const continues = segEnd < end + 0.2;
      if (continues) {
        fade.gain.setValueAtTime(1, segEnd - CROSSFADE);
        fade.gain.linearRampToValueAtTime(0, segEnd);
      }
      src.connect(fade).connect(env);
      src.start(start, offset);
      src.stop(Math.min(segEnd, end + 0.3));
      if (!continues) break;
      start = segEnd - CROSSFADE;
      offset = LOOP_FROM;
      first = false;
    }
  }
}

/** Réponse impulsionnelle de petite salle, générée (pas de fichier à embarquer). */
function roomImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const b = ctx.createBuffer(2, Math.floor(rate * seconds), rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let smooth = 0;
    for (let i = 0; i < d.length; i++) {
      smooth = smooth * 0.55 + (Math.random() * 2 - 1) * 0.45;
      d[i] = smooth * Math.pow(1 - i / d.length, 3.2) * (i < rate * 0.012 ? i / (rate * 0.012) : 1);
    }
  }
  return b;
}
