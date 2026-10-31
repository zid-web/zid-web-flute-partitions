import { describe, expect, it } from "vitest";
import { Accompanist, WAIT_GRACE } from "../accompanist";

// Flûte : une note par seconde de partition (noires à ♩ = 60).
const FLUTE = [0, 1, 2, 3, 4, 5, 6, 7];

/** Fait tourner l'horloge par pas de 25 ms et renvoie les fenêtres programmées. */
function run(a: Accompanist, from: number, to: number, lookahead = 0.15) {
  const windows: { from: number; to: number; at: number }[] = [];
  for (let t = from; t < to; t += 0.025) {
    const w = a.advance(t, lookahead);
    if (w) windows.push({ ...w, at: a.toAudio(w.from) });
  }
  return windows;
}

describe("accompagnateur qui suit la flûte", () => {
  it("joue en continu, sans trou ni doublon, en avance sur l'heure entendue", () => {
    const a = new Accompanist(FLUTE, 1);
    a.start(0, 10);
    a.hit(0, 10);
    const w = run(a, 10, 10.9);
    for (let i = 1; i < w.length; i++) expect(w[i].from).toBeCloseTo(w[i - 1].to, 9);
    expect(w[0].from).toBe(0);
    expect(w[w.length - 1].to).toBeGreaterThan(0.9); // déjà programmé au-delà de l'heure
  });

  it("le piano tombe pile sur l'attaque prévue de la flûte quand elle joue en mesure", () => {
    const a = new Accompanist(FLUTE, 1);
    a.start(0, 10);
    for (let k = 0; k < 4; k++) a.hit(k, 10 + k);
    expect(a.toAudio(4)).toBeCloseTo(14, 9);
    expect(a.tempoRatio).toBeCloseTo(1, 9);
  });

  it("suit un flûtiste qui accélère, et se recale sur chaque attaque", () => {
    const a = new Accompanist(FLUTE, 1);
    a.start(0, 10);
    // la flûte joue à ♩ = 75 (0,8 s par note)
    for (let k = 0; k < 6; k++) a.hit(k, 10 + 0.8 * k);
    expect(a.tempoRatio).toBeGreaterThan(1.2);
    // prochaine note prévue à 10 + 0,8 × 6 = 14,8 s, à quelques ms près
    expect(Math.abs(a.toAudio(6) - 14.8)).toBeLessThan(0.02);
  });

  it("attend la flûte : joue l'accord de la note attendue puis s'arrête juste après", () => {
    const a = new Accompanist(FLUTE, 1);
    a.start(0, 10);
    a.hit(0, 10);
    a.hit(1, 11);
    // la flûte s'arrête : le piano va jusqu'au début de la note 2 (+ la marge), pas plus loin
    const w = run(a, 11, 20);
    expect(Math.max(...w.map((x) => x.to))).toBeCloseTo(2 + WAIT_GRACE, 9);
    // elle reprend (en retard) sur la note 2 : le piano repart de là, calé sur elle
    a.hit(2, 20);
    expect(a.toAudio(3)).toBeCloseTo(21, 9);
    const next = a.advance(20.1, 0.15)!;
    expect(next.from).toBeCloseTo(2 + WAIT_GRACE, 9);
    expect(next.to).toBeCloseTo(2.25, 9);
  });

  it("attaques mesurées avec un peu d'imprécision : la prévision reste plus précise que la mesure", () => {
    const a = new Accompanist(FLUTE, 1);
    a.start(0, 10);
    const jitter = [0, 0.03, -0.03, 0.03, -0.03, 0.03, -0.03];
    for (let k = 0; k < 7; k++) {
      if (k > 2) expect(Math.abs(a.toAudio(k) - (10 + k))).toBeLessThan(0.025);
      a.hit(k, 10 + k + jitter[k]);
    }
    expect(Math.abs(a.toAudio(7) - 17)).toBeLessThan(0.02);
  });

  it("une note tenue très longtemps ne fait pas s'effondrer le tempo", () => {
    const a = new Accompanist(FLUTE, 1);
    a.start(0, 10);
    a.hit(0, 10);
    a.hit(1, 11);
    a.hit(2, 19); // 8 s au lieu d'1 : pause, pas un tempo
    expect(a.tempoRatio).toBeCloseTo(1, 9);
    expect(a.toAudio(3)).toBeCloseTo(20, 9);
  });

  it("introduction : le piano joue seul avant la première note, au tempo choisi", () => {
    const a = new Accompanist([2, 3, 4], 2); // tempo choisi deux fois plus rapide
    a.start(0, 10);
    expect(a.toAudio(2)).toBeCloseTo(11, 9);
    // sans la flûte, il joue l'introduction et l'accord de la 1ʳᵉ note, puis attend
    const w = run(a, 10, 15);
    expect(Math.max(...w.map((x) => x.to))).toBeCloseTo(2 + WAIT_GRACE, 9);
  });
});
