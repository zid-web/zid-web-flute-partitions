// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_QPM, tempoMap } from "../tempo";

const measure = (inner = "") => `<measure>${inner}<note><rest/><duration>4</duration></note></measure>`;
const score = (...measures: string[]) =>
  `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"/></part-list><part id="P1">${measures.join("")}</part></score-partwise>`;
const metronome = (unit: string, perMinute: number, dot = false) =>
  `<direction><direction-type><metronome><beat-unit>${unit}</beat-unit>${dot ? "<beat-unit-dot/>" : ""}<per-minute>${perMinute}</per-minute></metronome></direction-type></direction>`;

describe("tempoMap", () => {
  it("sans indication : 120 comme MuseScore", () => {
    expect(tempoMap(score(measure(), measure()))).toEqual([DEFAULT_QPM, DEFAULT_QPM]);
  });

  it("<sound tempo> prime et vaut jusqu'au changement suivant", () => {
    const xml = score(measure('<direction><sound tempo="96"/></direction>'), measure(), measure('<sound tempo="60"/>'), measure());
    expect(tempoMap(xml)).toEqual([96, 96, 60, 60]);
  });

  it("indication métronomique convertie en noires par minute", () => {
    expect(tempoMap(score(measure(metronome("quarter", 80))))).toEqual([80]);
    expect(tempoMap(score(measure(metronome("half", 60))))).toEqual([120]);
    // 6/8 : noire pointée = 60 → 90 noires par minute
    expect(tempoMap(score(measure(metronome("quarter", 60, true))))).toEqual([90]);
    // tempos rapides : plus de limite à 140
    expect(tempoMap(score(measure(metronome("quarter", 168))))).toEqual([168]);
  });

  it("partitions de la bibliothèque", () => {
    const read = (f: string) => readFileSync(join(__dirname, "../../../public/scores", f), "utf8");
    expect(tempoMap(read("au-clair-de-la-lune.musicxml"))[0]).toBe(80);
    expect(tempoMap(read("menuet-en-sol.musicxml"))[0]).toBe(104);
  });
});

describe("import : tempo écrit dans une autre partie", () => {
  it("recopie le tempo de la première partie dans la partie de flûte gardée", async () => {
    const { prepareImport } = await import("../import");
    const xml = `<?xml version="1.0"?><score-partwise><part-list>
<score-part id="P1"><part-name>Piano</part-name></score-part>
<score-part id="P2"><part-name>Flûte</part-name></score-part></part-list>
<part id="P1">
<measure number="1"><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>132</per-minute></metronome></direction-type><sound tempo="132"/></direction><attributes><divisions>1</divisions></attributes><note><rest/><duration>4</duration></note></measure>
<measure number="2"><sound tempo="66"/><note><rest/><duration>4</duration></note></measure></part>
<part id="P2">
<measure number="1"><attributes><divisions>1</divisions></attributes>${"<note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration></note>".repeat(4)}</measure>
<measure number="2">${"<note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration></note>".repeat(4)}</measure></part>
</score-partwise>`;
    const { xml: kept } = prepareImport(xml, "duo.musicxml");
    expect(kept).not.toContain("Piano");
    expect(tempoMap(kept)).toEqual([132, 66]);
  });
});
