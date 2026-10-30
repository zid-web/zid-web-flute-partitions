import { PitchDetector } from "pitchy";
import { FLUTE_RANGE, freqToMidi } from "./notes";

export interface PitchReading {
  /** Hauteur MIDI fractionnaire, null si silence / son non périodique. */
  midi: number | null;
  clarity: number;
  level: number;
  timeMs: number;
}

/**
 * Écoute le micro et estime la hauteur jouée (algorithme McLeod via pitchy).
 * Fonctionne entièrement en local : aucun son n'est envoyé sur Internet.
 */
export class MicPitchSource {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;

  constructor(
    private readonly onReading: (r: PitchReading) => void,
    private readonly minClarity = 0.9,
    private readonly minLevel = 0.01,
    /** Avec l'accompagnement de piano : on retire du micro le son du haut-parleur. */
    private readonly echoCancellation = false,
  ) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: this.echoCancellation, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const buffer = new Float32Array(analyser.fftSize);
    const detector = PitchDetector.forFloat32Array(analyser.fftSize);
    const sampleRate = this.ctx.sampleRate;

    const tick = () => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
      const level = Math.sqrt(sum / buffer.length);
      const [freq, clarity] = detector.findPitch(buffer, sampleRate);
      const midi = freq > 0 ? freqToMidi(freq) : 0;
      const valid =
        level >= this.minLevel &&
        clarity >= this.minClarity &&
        midi >= FLUTE_RANGE.low - 2 &&
        midi <= FLUTE_RANGE.high + 2;
      this.onReading({ midi: valid ? midi : null, clarity, level, timeMs: performance.now() });
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.stream = null;
  }
}
