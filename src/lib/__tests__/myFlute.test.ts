import { describe, expect, it } from "vitest";
import { analyseTake } from "../myFlute";

const RATE = 44100;

/** Son de type flûte (fondamentale + harmoniques faibles), avec silence avant et après. */
function tone(midi: number, seconds: number, { cents = 0, amp = 0.3, before = 0.3, after = 0.5 } = {}): Float32Array {
  const f = 440 * Math.pow(2, (midi - 69 + cents / 100) / 12);
  const out = new Float32Array(Math.floor((before + seconds + after) * RATE));
  const s0 = Math.floor(before * RATE);
  for (let i = 0; i < seconds * RATE; i++) {
    const t = i / RATE;
    const env = Math.min(1, t / 0.05) * Math.min(1, (seconds - t) / 0.05);
    out[s0 + i] = amp * env * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t) + 0.1 * Math.sin(6 * Math.PI * f * t));
  }
  return out;
}

describe("analyse d'une prise de « Ma flûte »", () => {
  it("note juste et tenue : acceptée, nettoyée", () => {
    const a = analyseTake(tone(69, 3), RATE, 69);
    expect(a.ok).toBe(true);
    expect(Math.abs(a.cents ?? 99)).toBeLessThanOrEqual(5);
    expect(a.heldSeconds).toBeGreaterThan(2.5);
    // le silence de départ est retiré, l'attaque est au début
    expect(a.pcm!.length).toBeLessThan(3.3 * RATE);
    expect(Math.abs(a.pcm![Math.floor(0.1 * RATE)])).toBeGreaterThan(0);
  });

  it("légèrement haute : acceptée (corrigée à la lecture)", () => {
    const a = analyseTake(tone(72, 3, { cents: 20 }), RATE, 72);
    expect(a.ok).toBe(true);
    expect(a.cents).toBeGreaterThanOrEqual(15);
    expect(a.cents).toBeLessThanOrEqual(25);
  });

  it("trop haute de 40 cents : refusée", () => {
    const a = analyseTake(tone(72, 3, { cents: 40 }), RATE, 72);
    expect(a.ok).toBe(false);
    expect(a.message).toMatch(/trop haute/);
  });

  it("mauvaise note ou mauvaise octave : refusée avec l'écart", () => {
    expect(analyseTake(tone(71, 3), RATE, 69).message).toMatch(/trop haut \(2 demi-tons\)/);
    expect(analyseTake(tone(81, 3), RATE, 69).message).toMatch(/une octave/);
  });

  it("trop courte ou silence : refusée", () => {
    expect(analyseTake(tone(69, 0.8), RATE, 69).message).toMatch(/trop courte/);
    expect(analyseTake(new Float32Array(3 * RATE), RATE, 69).message).toMatch(/n'entends/);
  });
});
