import { describe, expect, it } from "vitest";
import { countIn, nextLoopTempo, RhythmTracker, rhythmSummary, stepRange } from "../practice";

// 4 mesures de 4 noires à ♩ = 60 : une note par seconde
const steps = Array.from({ length: 16 }, (_, i) => ({ measure: Math.floor(i / 4), startSec: i }));

describe("boucle sur un passage", () => {
  it("notes des mesures choisies (numéros à partir de 1, dans n'importe quel ordre)", () => {
    expect(stepRange(steps, 2, 3)).toEqual({ first: 4, last: 11 });
    expect(stepRange(steps, 3, 2)).toEqual({ first: 4, last: 11 });
    expect(stepRange(steps, 4, 4)).toEqual({ first: 12, last: 15 });
    expect(stepRange(steps, 9, 10)).toBeNull();
  });

  it("une mesure sans note (silences) au début du passage : on commence à la suivante", () => {
    const withRest = steps.filter((s) => s.measure !== 1);
    expect(stepRange(withRest, 2, 3)).toEqual({ first: 4, last: 7 });
  });

  it("tempo progressif : monte après un passage réussi, jusqu'à l'objectif", () => {
    expect(nextLoopTempo(60, 80, true)).toBe(64);
    expect(nextLoopTempo(78, 80, true)).toBe(80);
    expect(nextLoopTempo(80, 80, true)).toBe(80);
    expect(nextLoopTempo(60, 80, false)).toBe(60);
  });
});

describe("décompte", () => {
  it("une mesure de clics, à la durée du temps", () => {
    expect(countIn(4, 4, 60)).toEqual({ clicks: 4, beatSec: 1 });
    expect(countIn(3, 4, 120)).toEqual({ clicks: 3, beatSec: 0.5 });
    expect(countIn(6, 8, 60)).toEqual({ clicks: 6, beatSec: 0.5 }); // croches
    expect(countIn(2, 2, 60)).toEqual({ clicks: 2, beatSec: 2 }); // blanches
  });
});

describe("rythme", () => {
  const expected = Array.from({ length: 12 }, (_, i) => i); // une note par seconde

  it("jeu régulier : tout à l'heure, même à un autre tempo que l'écrit", () => {
    const r = new RhythmTracker(expected, 1);
    expect(r.hit(0, 10)).toBeNull(); // la première n'est pas jugée
    for (let i = 1; i < 8; i++) expect(r.hit(i, 10 + i * 0.8)?.verdict).toBe("on"); // ♩ = 75, régulier
    expect(r.report).toEqual({ evaluated: 7, onTime: 7, early: 0, late: 0, percent: 100 });
  });

  it("une note bousculée ou traînée", () => {
    const r = new RhythmTracker(expected, 1);
    r.hit(0, 0);
    r.hit(1, 1);
    r.hit(2, 2);
    expect(r.hit(3, 2.6)).toEqual({ verdict: "early", deviationMs: -400 });
    expect(r.hit(4, 4.0)?.verdict).toBe("late");
    expect(rhythmSummary(r.report)).toBe("Rythme : 50 % des notes à l'heure (1 en avance, 1 en retard).");
  });

  it("petits écarts (moins de 70 ms) : à l'heure", () => {
    const r = new RhythmTracker(expected, 1);
    r.hit(0, 0);
    expect(r.hit(1, 1.05)?.verdict).toBe("on");
    expect(r.hit(2, 1.99)?.verdict).toBe("on");
  });

  it("après une longue pause, on repart sans juger", () => {
    const r = new RhythmTracker(expected, 1);
    r.hit(0, 0);
    r.hit(1, 1);
    expect(r.hit(2, 6)).toBeNull();
    expect(r.hit(3, 7)?.verdict).toBe("on");
  });

  it("nouveau passage (boucle) : la reprise n'est pas jugée, les compteurs repartent", () => {
    const r = new RhythmTracker(expected, 1);
    r.hit(0, 0);
    r.hit(1, 1);
    r.restart();
    r.resetCounts();
    expect(r.hit(0, 30)).toBeNull();
    expect(r.report.evaluated).toBe(0);
    expect(rhythmSummary(r.report)).toBe("Rythme : pas assez de notes pour juger.");
  });
});
