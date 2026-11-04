import { describe, expect, it } from "vitest";
import { NoteStream } from "../noteStream";

describe("programmation au fil de l'eau", () => {
  it("ne donne que les notes à venir avant l'horizon, une seule fois, dans l'ordre", () => {
    const s = new NoteStream([0, 1, 2, 5, 9], (t) => 10 + t);
    expect(s.take(12)).toEqual([0, 1]);
    expect(s.take(12)).toEqual([]);
    expect(s.take(16)).toEqual([2, 5]);
    expect(s.done).toBe(false);
    expect(s.take(100)).toEqual([9]);
    expect(s.done).toBe(true);
  });

  it("orchestre : 30 000 notes, chaque appel n'en programme que quelques secondes", () => {
    const notes = Array.from({ length: 30000 }, (_, i) => i * 0.05); // 20 notes par seconde
    const s = new NoteStream(notes, (t) => t);
    expect(s.take(4).length).toBe(80);
  });
});
