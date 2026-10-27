import { midiToFreq } from "./notes";

/** Petit synthétiseur « flûte » (sinus + souffle + vibrato) pour le mode Écouter. */
export class FluteSynth {
  private ctx = new AudioContext();

  async resume(): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  play(midi: number, durationSec: number): void {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = midiToFreq(midi);

    const vibrato = ctx.createOscillator();
    const vibratoGain = ctx.createGain();
    vibrato.frequency.value = 5;
    vibratoGain.gain.value = midiToFreq(midi) * 0.004;
    vibrato.connect(vibratoGain).connect(osc.frequency);

    const overtone = ctx.createOscillator();
    overtone.frequency.value = midiToFreq(midi) * 2;
    const overtoneGain = ctx.createGain();
    overtoneGain.gain.value = 0.08;
    overtone.connect(overtoneGain);

    const env = ctx.createGain();
    const end = t0 + Math.max(durationSec * 0.92, 0.08);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(0.25, t0 + 0.04);
    env.gain.setValueAtTime(0.22, end - 0.05);
    env.gain.linearRampToValueAtTime(0, end);

    osc.connect(env);
    overtoneGain.connect(env);
    env.connect(ctx.destination);
    for (const o of [osc, vibrato, overtone]) {
      o.start(t0);
      o.stop(end + 0.02);
    }
  }

  close(): void {
    void this.ctx.close();
  }
}
