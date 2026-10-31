import type { PianoNote } from "./accompaniment";
import { pickSample } from "./sampler";

/**
 * Vrai piano (Salamander Grand Piano, Yamaha C5, CC-BY 3.0 — public/samples/piano/CREDITS.txt),
 * embarqué dans l'application (hors ligne). Un enregistrement tous les 3 demi-tons : chaque note
 * est frappée depuis le plus proche (±1 demi-ton). Nuances : volume et brillance ; fin de note :
 * l'étouffoir retombe (extinction rapide), comme sur un vrai piano.
 */
export class PianoSampler {
  readonly ctx: BaseAudioContext;
  private output: AudioNode;
  private bus: GainNode;
  private notes: number[];

  private constructor(ctx: BaseAudioContext, private buffers: Map<number, AudioBuffer>) {
    this.ctx = ctx;
    this.notes = [...buffers.keys()].sort((a, b) => a - b);
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.ratio.value = 3;
    compressor.connect(ctx.destination);
    this.output = compressor;
    this.bus = this.newBus();
  }

  /** Charge les enregistrements (depuis le cache hors ligne après la première visite). */
  static async load(ctx: BaseAudioContext, baseUrl = import.meta.env.BASE_URL): Promise<PianoSampler> {
    const dir = `${baseUrl}samples/piano/`;
    const notes = (await (await fetch(`${dir}notes.json`)).json()) as number[];
    const entries = await Promise.all(
      notes.map(async (midi) => {
        const res = await fetch(`${dir}piano-${midi}.mp3`);
        if (!res.ok) throw new Error(`Échantillon de piano manquant (${midi})`);
        return [midi, await ctx.decodeAudioData(await res.arrayBuffer())] as const;
      }),
    );
    return new PianoSampler(ctx, new Map(entries));
  }

  /**
   * Programme des notes : `t0` = heure audio du temps `origin` de la partition ; `speed` = rapport
   * entre le tempo choisi et le tempo écrit. Les notes avant `origin` ou après `until` sont ignorées,
   * ainsi que celles dont l'heure est passée de plus de `late` secondes (les autres sont jouées tout de suite).
   */
  schedule(notes: PianoNote[], t0: number, { origin = 0, until = Infinity, speed = 1, late = 0.01 } = {}): void {
    for (const n of notes) {
      if (n.startSec < origin - 1e-6 || n.startSec >= until - 1e-6) continue;
      const at = t0 + (n.startSec - origin) / speed;
      if (at < this.ctx.currentTime - late) continue;
      // staccato (gate < 1) : l'étouffoir retombe plus tôt
      this.strike(n.midi, Math.max(at, this.ctx.currentTime), (n.seconds * (n.gate ?? 1)) / speed, n.velocity);
    }
  }

  stop(): void {
    const old = this.bus;
    const now = this.ctx.currentTime;
    old.gain.cancelScheduledValues(now);
    old.gain.setValueAtTime(old.gain.value, now);
    old.gain.linearRampToValueAtTime(0, now + 0.08);
    setTimeout(() => old.disconnect(), 300);
    this.bus = this.newBus();
  }

  private newBus(): GainNode {
    const bus = this.ctx.createGain();
    bus.gain.value = 0.8;
    bus.connect(this.output);
    return bus;
  }

  private strike(midi: number, t: number, seconds: number, velocity: number): void {
    const { sample, rate } = pickSample(midi, this.notes);
    const buffer = this.buffers.get(sample);
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    // Jouer doucement, c'est aussi un son plus rond : on assombrit les nuances faibles.
    const tone = this.ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 1800 + 14000 * velocity * velocity;
    const env = this.ctx.createGain();
    const level = 0.12 + 0.6 * Math.pow(velocity, 1.6);
    const end = t + Math.max(0.12, seconds);
    env.gain.setValueAtTime(level, t);
    env.gain.setTargetAtTime(0, end, 0.09); // l'étouffoir retombe
    src.connect(tone).connect(env).connect(this.bus);
    src.start(t);
    src.stop(Math.min(end + 0.6, t + buffer.duration / rate));
  }
}
