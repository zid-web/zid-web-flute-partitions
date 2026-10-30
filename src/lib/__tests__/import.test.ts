// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { analyseScore, parseMusicXml } from "../difficulty";
import { prepareImport, readScoreBytes } from "../import";

const SCORES = join(__dirname, "../../../public/scores");
const catalog = JSON.parse(readFileSync(join(SCORES, "catalog.json"), "utf8")) as {
  scores: { id: string; file: string; complexity: number; level: number; noteCount: number }[];
};

const DUET = `<?xml version="1.0"?><score-partwise><work><work-title>Duo</work-title></work><part-list>
<score-part id="P1"><part-name>Piano</part-name></score-part>
<score-part id="P2"><part-name>Flûte</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>
<note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration></note></measure></part>
<part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes>
<note><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration></note>
<note><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration></note></measure></part>
</score-partwise>`;

describe("analyse de difficulté (portage du skill Python)", () => {
  it.each(catalog.scores)("$id : même complexité et même niveau que catalog.json", (s) => {
    const a = analyseScore(parseMusicXml(readFileSync(join(SCORES, s.file), "utf8")));
    expect(a.complexity).toBe(s.complexity);
    expect(a.level).toBe(s.level);
    expect(a.noteCount).toBe(s.noteCount);
  });
});

describe("import d'une partition", () => {
  it("garde seulement la partie de flûte", () => {
    const { xml, entry, warnings } = prepareImport(DUET, "duo.musicxml");
    expect(xml).not.toContain("Piano");
    expect(entry.title).toBe("Duo");
    expect(entry.origin).toBe("import");
    expect(entry.range).toEqual({ low: "La4", high: "Si4" });
    expect(warnings).toEqual([]);
  });

  it("flûte + piano : garde la flûte, et le piano pour l'accompagnement", () => {
    const { entry, xml, accompaniment } = prepareImport(DUET, "duo.xml");
    expect(entry.kind).toBe("flute-piano");
    expect(xml).toContain("Flûte");
    expect(xml).not.toContain("Piano");
    expect(accompaniment).toContain("Piano");
    expect(accompaniment).not.toContain("Flûte");
  });

  it("sans flûte mais avec un piano : partition pour piano seul", () => {
    const { entry, xml, accompaniment, warnings } = prepareImport(DUET.replace("Flûte", "Violon"), "x.xml");
    expect(entry.kind).toBe("piano");
    expect(xml).toContain("Piano");
    expect(xml).not.toContain("Violon");
    expect(accompaniment).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("une seule partie de piano (nom « Piano » ou deux portées) : piano seul, pas flûte", () => {
    const solo = DUET.replace('<score-part id="P2"><part-name>Flûte</part-name></score-part>', "").replace(/<part id="P2">[\s\S]*?<\/part>/, "");
    expect(prepareImport(solo, "solo.xml").entry.kind).toBe("piano");
    const twoStaves = solo.replace("<part-name>Piano</part-name>", "<part-name>Instrument</part-name>").replace("<divisions>1</divisions>", "<divisions>1</divisions><staves>2</staves>");
    expect(prepareImport(twoStaves, "solo.xml").entry.kind).toBe("piano");
    // une seule partie sur une portée, sans nom d'instrument : la flûte, comme avant
    const melody = solo.replace("<part-name>Piano</part-name>", "<part-name>Instrument</part-name>");
    expect(prepareImport(melody, "solo.xml").entry.kind).toBe("flute");
  });

    it("refuse une partition sans flûte ni piano", () => {
    const strings = DUET.replace("Flûte", "Violon").replace("<part-name>Piano", "<part-name>Violoncelle");
    expect(() => prepareImport(strings, "x.xml")).toThrow(/Aucune partie de flûte ni de piano/);
  });

  it("refuse un fichier qui n'est pas du MusicXML", () => {
    expect(() => prepareImport("<html><body>404</body></html>", "x.xml")).toThrow();
  });

  it("décompresse un .mxl", async () => {
    const zip = new JSZip();
    zip.file("META-INF/container.xml", '<container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>');
    zip.file("score.xml", DUET);
    expect(await readScoreBytes(await zip.generateAsync({ type: "uint8array" }))).toBe(DUET);
    expect(await readScoreBytes(new TextEncoder().encode(DUET))).toBe(DUET);
  });
});
