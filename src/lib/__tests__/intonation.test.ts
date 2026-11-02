import { describe, expect, it } from "vitest";
import { IntonationTracker, intonationSummary, SKIP_AFTER_ATTACK } from "../intonation";

/** Joue la note `index` (attendue `midi`) avec `frames` mesures à `cents` d'écart. */
function hold(t: IntonationTracker, index: number, midi: number, cents: number, frames = 20) {
  t.noteStarted(index);
  for (let k = 0; k < frames; k++) t.frame(index, midi, midi + cents / 100);
}

describe("bilan de justesse", () => {
  it("moyenne par note, de la plus fausse à la plus juste", () => {
    const t = new IntonationTracker();
    hold(t, 0, 88, 22); // Mi6 trop haut
    hold(t, 1, 69, -3); // La4 juste
    hold(t, 2, 88, 18); // Mi6 encore trop haut
    hold(t, 3, 64, -15); // Mi4 trop bas
    const r = t.report;
    expect(r.notes.map((n) => [n.name, n.cents])).toEqual([
      ["Mi6", 20],
      ["Mi4", -15],
      ["La4", -3],
    ]);
    const s = intonationSummary(r);
    expect(s.headline).toMatch(/À travailler/);
    expect(s.details[0]).toMatch(/^Mi6 trop haut de 20 cents/);
    expect(s.details[1]).toMatch(/^Mi4 trop bas de 15 cents/);
    expect(s.details).toHaveLength(2); // le La4 est juste
  });

  it("l'attaque (premières mesures) et les sons trop éloignés ne comptent pas", () => {
    const t = new IntonationTracker();
    t.noteStarted(0);
    for (let k = 0; k < SKIP_AFTER_ATTACK; k++) t.frame(0, 69, 69.4); // attaque instable
    for (let k = 0; k < 10; k++) t.frame(0, 69, 69.05);
    t.frame(0, 69, 71); // glissement vers la note suivante
    expect(t.report.notes).toEqual([{ midi: 69, name: "La4", cents: 5, frames: 10 }]);
  });

  it("une note à peine effleurée n'est pas jugée ; mesures d'une autre note ignorées", () => {
    const t = new IntonationTracker();
    hold(t, 0, 72, 30, SKIP_AFTER_ATTACK + 3);
    t.frame(5, 72, 72.3); // pas la note en cours
    expect(intonationSummary(t.report).headline).toBe("Justesse : pas assez de notes tenues pour juger.");
  });

  it("tout juste : un compliment", () => {
    const t = new IntonationTracker();
    hold(t, 0, 72, 4);
    hold(t, 1, 74, -6);
    expect(intonationSummary(t.report)).toEqual({
      headline: "Justesse : très bien, toutes vos notes sont justes (écart moyen 5 cents).",
      details: [],
    });
  });
});
