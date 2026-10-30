import { describe, expect, it } from "vitest";
import { pickSample, sampleGain, sustainEnd } from "../sampler";

const NOTES = [60, 64, 69, 72, 76, 81, 84, 88, 93, 96];

describe("flûte échantillonnée", () => {
  it("joue chaque note de la flûte depuis l'enregistrement le plus proche (±2 demi-tons au plus)", () => {
    for (let midi = 59; midi <= 98; midi++) {
      const { sample, rate } = pickSample(midi, NOTES);
      expect(Math.abs(midi - sample)).toBeLessThanOrEqual(2);
      expect(rate).toBeCloseTo(Math.pow(2, (midi - sample) / 12), 10);
    }
  });

  it("note enregistrée : vitesse 1 ; à égalité, l'enregistrement du dessus", () => {
    expect(pickSample(69, NOTES)).toEqual({ sample: 69, rate: 1 });
    expect(pickSample(62, NOTES).sample).toBe(64);
  });

  it("plus doux dans le grave", () => {
    expect(sampleGain(60)).toBeLessThan(sampleGain(90));
  });
});

describe("fin de la partie tenue", () => {
  it("s'arrête où le son s'éteint", () => {
    const rate = 1000;
    const data = new Float32Array(3 * rate);
    for (let i = 0; i < data.length; i++) {
      const t = i / rate;
      const amp = t < 2 ? 1 : Math.max(0, 1 - (t - 2) * 2); // tenue 2 s puis extinction en 0,5 s
      data[i] = amp * Math.sin(2 * Math.PI * 50 * t);
    }
    expect(sustainEnd(data, rate)).toBeGreaterThan(1.9);
    expect(sustainEnd(data, rate)).toBeLessThan(2.25);
  });
});
