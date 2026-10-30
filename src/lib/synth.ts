import { midiToFreq } from "./notes";

/**
 * Synthétiseur de flûte traversière pour le mode « Écouter », entièrement local (aucun échantillon
 * à télécharger, fonctionne hors ligne). Ce qui fait « flûte » :
 * - un timbre proche du sinus, plus riche en harmoniques dans le grave et presque pur dans l'aigu ;
 * - le souffle : un bruit filtré autour de la note, plus marqué à l'attaque (« chiff ») ;
 * - une attaque douce avec une légère montée vers la justesse, puis un vibrato qui arrive après
 *   l'attaque, comme chez un flûtiste ;
 * - une petite réverbération de salle, et un compresseur pour éviter toute saturation.
 * Les notes sont programmées sur l'horloge audio : le rythme est exact, même si l'écran ralentit.
 */

/** Amplitudes relatives des harmoniques 1 à 6, du grave (Do4) à l'aigu (Do7). */
const LOW = [1, 0.5, 0.26, 0.12, 0.06, 0.03];
const MID = [1, 0.3, 0.1, 0.045, 0.02, 0.01];
const HIGH = [1, 0.12, 0.03, 0.01, 0, 0];

/** Harmoniques interpolées selon le registre (exporté pour les tests). */
export function harmonicsFor(midi: number): number[] {
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
  if (midi <= 72) return mix(LOW, MID, Math.max(0, (midi - 60) / 12));
  return mix(MID, HIGH, Math.min(1, (midi - 72) / 18));
}

/** Volume selon le registre : la flûte est douce dans le grave et brillante dans l'aigu. */
export function loudnessFor(midi: number): number {
  return 0.24 + 0.08 * Math.min(1, Math.max(0, (midi - 60) / 30));
}

export interface ScheduledNote {
  midi: number;
  /** Début, en secondes depuis le départ du morceau. */
  start: number;
  /** Durée écrite, en secondes. */
  duration: number;
}

const cents = (f: number, c: number) => f * Math.pow(2, c / 1200);

export class FluteSynth {
  readonly ctx: BaseAudioContext;
  private output: AudioNode;
  private bus: GainNode;
  private noise: AudioBuffer;
  private reverbIn: AudioNode;
  private waves = new Map<number, PeriodicWave>();

  private breathLevel: number;

  /**
   * `ctx` : contexte audio fourni (OfflineAudioContext pour les tests), sinon celui de l'appareil.
   * `reverb` (0–1) et `breath` (multiplicateur du souffle) servent aux réglages et aux tests.
   */
  constructor(ctx?: BaseAudioContext, { reverb: reverbLevel = 0.22, breath = 1 } = {}) {
    this.ctx = ctx ?? new AudioContext({ latencyHint: "playback" });
    const c = this.ctx;

    const compressor = c.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.2;
    compressor.connect(c.destination);
    this.output = compressor;

    const reverb = c.createConvolver();
    reverb.buffer = this.roomImpulse(1.6);
    const wet = c.createGain();
    wet.gain.value = reverbLevel;
    reverb.connect(wet).connect(compressor);

    this.bus = c.createGain();
    this.bus.connect(compressor);
    this.bus.connect(reverb);
    this.reverbIn = reverb;

    this.noise = this.whiteNoise(2);
    this.breathLevel = breath;
  }

  async resume(): Promise<void> {
    if (this.ctx instanceof AudioContext && this.ctx.state === "suspended") await this.ctx.resume();
  }

  /** Programme toute une mélodie ; renvoie l'heure audio du départ. */
  schedule(notes: ScheduledNote[], lead = 0.12): number {
    const t0 = this.ctx.currentTime + lead;
    notes.forEach((n, i) => {
      const next = notes[i + 1];
      // Liaison : une note suivie immédiatement d'une autre est à peine détachée (coup de langue léger).
      const legato = next !== undefined && Math.abs(next.start - (n.start + n.duration)) < 0.01;
      this.note(n.midi, t0 + n.start, n.duration, legato);
    });
    return t0;
  }

  /** Autre voix (2ᵉ flûte) depuis le temps `origin` de la partition (voir FlutePlayer). */
  scheduleAt(
    notes: { midi: number; startSec: number; seconds: number }[],
    t0: number,
    { origin = 0, until = Infinity, speed = 1 } = {},
  ): void {
    for (const n of notes) {
      if (n.startSec < origin - 1e-6 || n.startSec >= until - 1e-6) continue;
      const at = t0 + (n.startSec - origin) / speed;
      if (at < this.ctx.currentTime - 0.01) continue;
      this.note(n.midi, Math.max(at, this.ctx.currentTime), n.seconds / speed, false);
    }
  }

  /** Joue une seule note maintenant (aperçu). */
  play(midi: number, durationSec: number): void {
    this.note(midi, this.ctx.currentTime + 0.02, durationSec, false);
  }

  /** Arrête tout ce qui est programmé, avec un fondu très court (pas de clic). */
  stop(): void {
    const old = this.bus;
    const now = this.ctx.currentTime;
    old.gain.cancelScheduledValues(now);
    old.gain.setValueAtTime(old.gain.value, now);
    old.gain.linearRampToValueAtTime(0, now + 0.05);
    setTimeout(() => old.disconnect(), 200);
    this.bus = this.ctx.createGain();
    this.bus.connect(this.output);
    this.bus.connect(this.reverbIn);
  }

  close(): void {
    if (this.ctx instanceof AudioContext) void this.ctx.close();
  }

  private note(midi: number, t: number, written: number, legato: boolean): void {
    const c = this.ctx;
    const f = midiToFreq(midi);
    const sounding = Math.max(0.07, written * (legato ? 0.97 : 0.9));
    const end = t + sounding;
    const peak = loudnessFor(midi);
    const attack = midi < 72 ? 0.07 : 0.045; // le grave « parle » un peu plus lentement

    // Voix principale : forme d'onde à harmoniques, légère montée vers la justesse.
    const osc = c.createOscillator();
    osc.setPeriodicWave(this.wave(midi));
    osc.frequency.setValueAtTime(cents(f, -18), t);
    osc.frequency.exponentialRampToValueAtTime(f, t + attack * 0.9);

    // Vibrato différé (seulement sur les notes assez longues pour qu'on l'entende).
    if (sounding > 0.35) {
      const lfo = c.createOscillator();
      lfo.frequency.value = 5.2;
      const depth = c.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.setValueAtTime(0, t + 0.22);
      depth.gain.linearRampToValueAtTime(cents(f, 11) - f, t + 0.5);
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(end + 0.15);
    }

    const env = c.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + attack);
    env.gain.setTargetAtTime(peak * 0.88, t + attack, 0.25); // le son se pose après l'attaque
    env.gain.setTargetAtTime(0, end, 0.035);
    osc.connect(env).connect(this.bus);
    osc.start(t);
    osc.stop(end + 0.25);

    // Souffle : bruit filtré autour de la note (continu, discret) + « chiff » d'attaque.
    const breath = c.createBufferSource();
    breath.buffer = this.noise;
    breath.loop = true;
    const band = c.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = f * 1.5;
    band.Q.value = 1.2;
    const breathGain = c.createGain();
    const hiss = peak * (midi < 72 ? 0.11 : 0.07) * this.breathLevel;
    breathGain.gain.setValueAtTime(0, t);
    breathGain.gain.linearRampToValueAtTime(hiss * (legato ? 1 : 2.6), t + 0.015);
    breathGain.gain.setTargetAtTime(hiss * 0.45, t + 0.03, 0.05);
    breathGain.gain.setTargetAtTime(0, end, 0.03);
    breath.connect(band).connect(breathGain).connect(this.bus);
    breath.start(t, Math.random() * 1.5);
    breath.stop(end + 0.2);
  }

  private wave(midi: number): PeriodicWave {
    const key = Math.round(midi);
    let w = this.waves.get(key);
    if (!w) {
      const h = harmonicsFor(key);
      const real = new Float32Array(h.length + 1);
      const imag = new Float32Array([0, ...h]);
      w = this.ctx.createPeriodicWave(real, imag);
      this.waves.set(key, w);
    }
    return w;
  }

  private whiteNoise(seconds: number): AudioBuffer {
    const b = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * seconds), this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  /** Réponse impulsionnelle de petite salle, générée (pas de fichier à embarquer). */
  private roomImpulse(seconds: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const b = this.ctx.createBuffer(2, Math.floor(rate * seconds), rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let smooth = 0;
      for (let i = 0; i < d.length; i++) {
        const decay = Math.pow(1 - i / d.length, 3.2);
        smooth = smooth * 0.55 + (Math.random() * 2 - 1) * 0.45; // un peu plus sombre qu'un bruit blanc
        d[i] = smooth * decay * (i < rate * 0.012 ? i / (rate * 0.012) : 1);
      }
    }
    return b;
  }
}
