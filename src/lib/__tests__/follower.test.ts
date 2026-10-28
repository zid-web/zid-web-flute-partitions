import { describe, expect, it } from "vitest";
import { ScoreFollower, starsFor } from "../follower";
import { freqToMidi, midiToName } from "../notes";

const opts = { toleranceCents: 45, holdMs: 90, octaveTolerant: false };

function play(f: ScoreFollower, midi: number | null, fromMs: number, durMs: number) {
  const events = [];
  for (let t = fromMs; t <= fromMs + durMs; t += 10) events.push(...f.push({ midi, timeMs: t }));
  return events;
}

describe("notes", () => {
  it("convertit fréquence et noms", () => {
    expect(freqToMidi(440)).toBeCloseTo(69);
    expect(Math.round(freqToMidi(261.63))).toBe(60);
    expect(midiToName(60)).toBe("Do4");
    expect(midiToName(70)).toBe("Si♭4");
  });
});

describe("ScoreFollower", () => {
  it("valide une note tenue assez longtemps", () => {
    const f = new ScoreFollower([60, 62], opts);
    expect(play(f, 60, 0, 50)).toEqual([]);
    expect(play(f, 60, 60, 50)).toEqual([{ type: "hit", index: 0 }]);
    expect(f.position).toBe(1);
  });

  it("accepte une légère fausseté mais pas un demi-ton", () => {
    const f = new ScoreFollower([69], opts);
    expect(play(f, 69.3, 0, 100)).toEqual([{ type: "hit", index: 0 }, { type: "finished" }]);
    const g = new ScoreFollower([69], opts);
    expect(play(g, 70, 0, 100).some((e) => e.type === "hit")).toBe(false);
  });

  it("exige une nouvelle attaque pour deux notes identiques", () => {
    const f = new ScoreFollower([67, 67, 69], opts);
    play(f, 67, 0, 400);
    expect(f.position).toBe(1);
    play(f, null, 410, 30);
    play(f, 67, 450, 100);
    expect(f.position).toBe(2);
  });

  it("reconnaît un coup de langue sans silence entre deux notes identiques", () => {
    const f = new ScoreFollower([67, 67, 67], opts);
    const note = (from: number) => {
      // attaque, tenue, puis chute de volume (coup de langue) sans jamais perdre la hauteur
      for (let t = 0; t <= 450; t += 10) {
        const level = t < 30 ? 0.05 + t / 200 : t > 380 ? 0.03 : 0.17;
        f.push({ midi: 67, timeMs: from + t, level });
      }
    };
    note(0);
    note(460);
    note(920);
    expect(f.position).toBe(3);
  });

  it("la résonance qui s'éteint n'est pas une nouvelle note", () => {
    const f = new ScoreFollower([67, 67], opts);
    for (let t = 0; t <= 400; t += 10) f.push({ midi: 67, timeMs: t, level: 0.17 });
    // réverbération : même hauteur, volume qui décroît sans remonter
    for (let t = 410; t <= 1500; t += 10) f.push({ midi: 67, timeMs: t, level: 0.17 * Math.exp(-(t - 400) / 150) + 0.002 });
    expect(f.position).toBe(1);
  });

  it("une note longue qui faiblit un peu n'est pas comptée deux fois", () => {
    const f = new ScoreFollower([67, 67], opts);
    for (let t = 0; t <= 1000; t += 10) f.push({ midi: 67, timeMs: t, level: 0.2 - t * 0.0001 });
    expect(f.position).toBe(1);
  });

  it("ne compte pas la fin de la note précédente comme fausse note", () => {
    const f = new ScoreFollower([67, 69], opts);
    const ev = play(f, 67, 0, 600);
    expect(ev.filter((e) => e.type === "wrong")).toHaveLength(0);
    play(f, 69, 610, 100);
    expect(f.position).toBe(2);
  });

  it("signale une fausse note une seule fois", () => {
    const f = new ScoreFollower([60], opts);
    const ev = play(f, 64, 0, 500);
    expect(ev.filter((e) => e.type === "wrong")).toHaveLength(1);
  });

  it("tolère l'octave si demandé", () => {
    const f = new ScoreFollower([60], { ...opts, octaveTolerant: true });
    expect(play(f, 72, 0, 100)[0]).toEqual({ type: "hit", index: 0 });
  });

  it("calcule les étoiles", () => {
    expect(starsFor(20, 0)).toBe(3);
    expect(starsFor(20, 3)).toBe(2);
    expect(starsFor(20, 10)).toBe(1);
  });
});
