// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { FERMATA_HOLD, readExpressiveMarks, RIT_END, timeWarp } from "../expressive";

const n = (step: string, extra = "") => `<note><pitch><step>${step}</step><octave>5</octave></pitch><duration>1</duration>${extra}</note>`;
const words = (w: string) => `<direction><direction-type><words>${w}</words></direction-type></direction>`;
const fermata = "<notations><fermata/></notations>";
/** Mesures de 4 noires à ♩ = 60 (une noire = 1 s). */
const piece = (...measures: string[]) => `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Flûte</part-name></score-part></part-list>
<part id="P1">${measures.map((body, i) => `<measure number="${i + 1}">${i === 0 ? '<attributes><divisions>1</divisions></attributes><sound tempo="60"/>' : ""}${body}</measure>`).join("")}</part></score-partwise>`;
const four = n("C") + n("D") + n("E") + n("F");

describe("points d'orgue et ralentis en mode Écouter", () => {
  it("sans indication : le temps joué est le temps écrit", () => {
    const w = timeWarp(readExpressiveMarks(piece(four, four)));
    expect(w(5)).toBe(5);
  });

  it("point d'orgue : la note dure plus longtemps, la suite est décalée d'autant", () => {
    const marks = readExpressiveMarks(piece(n("C") + n("D") + n("E") + n("F", fermata), four));
    expect(marks.fermatas).toEqual([{ at: 3, seconds: 1 }]);
    const w = timeWarp(marks);
    expect(w(3)).toBeCloseTo(3, 6); // avant : inchangé
    expect(w(4)).toBeCloseTo(3 + FERMATA_HOLD, 6); // la note tenue 1,8 s au lieu d'1
    expect(w(6)).toBeCloseTo(5 + FERMATA_HOLD, 6); // la suite, décalée
  });

  it("rit. jusqu'à « a tempo » : ralentit progressivement, puis reprend le tempo", () => {
    const marks = readExpressiveMarks(piece(four, words("poco rit.") + four, words("a tempo") + four));
    expect(marks.tempoChanges).toEqual([{ from: 4, to: 8, factor: RIT_END }]);
    const w = timeWarp(marks);
    const beat = (k: number) => w(k + 1) - w(k);
    expect(beat(4)).toBeLessThan(beat(5));
    expect(beat(5)).toBeLessThan(beat(7)); // de plus en plus lent
    expect(beat(7)).toBeLessThan(RIT_END); // jusqu'à ~70 % du tempo
    expect(beat(9)).toBeCloseTo(1, 6); // a tempo
  });

  it("rit. sans « a tempo » : au plus deux mesures ; accel. presse", () => {
    const marks = readExpressiveMarks(piece(words("rall.") + four, four, four, four));
    expect(marks.tempoChanges).toEqual([{ from: 0, to: 8, factor: RIT_END }]);
    const acc = readExpressiveMarks(piece(words("accel.") + four, four));
    const w = timeWarp(acc);
    expect(w(8)).toBeLessThan(8);
  });

  it("un point d'orgue sur plusieurs parties à la même place ne compte qu'une fois", () => {
    const two = `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Flûte</part-name></score-part><score-part id="P2"><part-name>Piano</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><sound tempo="60"/>${n("C") + n("D") + n("E") + n("F", fermata)}</measure></part>
<part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes>${n("C") + n("D") + n("E") + n("F", fermata)}</measure></part></score-partwise>`;
    expect(readExpressiveMarks(two).fermatas).toHaveLength(1);
  });
});

describe("partition reconnue de travers", () => {
  it("une durée illisible ne rend pas tout le calendrier invalide (NaN)", async () => {
    const { measureTimeline } = await import("../accompaniment");
    const bad = piece(n("C") + `<note><pitch><step>D</step><octave>5</octave></pitch><duration>abc</duration></note>` + n("E"), four);
    const t = measureTimeline(bad);
    expect(t.startSec.every(Number.isFinite)).toBe(true);
    expect(t.startSec[1]).toBeCloseTo(2, 6); // la note illisible compte pour 0
    const w = timeWarp(readExpressiveMarks(bad));
    expect(Number.isFinite(w(5))).toBe(true);
  });
});
