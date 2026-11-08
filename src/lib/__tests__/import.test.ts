// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { analyseScore, parseMusicXml } from "../difficulty";
import { melodyNotes, partnersOf, pianoNotes, splitAccompaniment } from "../accompaniment";
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

  it("duo de flûtes (+ piano) : vous jouez la 1ʳᵉ, l'application garde la 2ᵉ et le piano", () => {
    const trio = DUET.replace(
      '<score-part id="P2"><part-name>Flûte</part-name></score-part>',
      '<score-part id="P2"><part-name>Flûte 1</part-name></score-part><score-part id="P3"><part-name>Flûte 2</part-name></score-part>',
    ).replace("</score-partwise>", '<part id="P3"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration></note></measure></part></score-partwise>');
    const { entry, xml, accompaniment } = prepareImport(trio, "trio.xml");
    expect(entry.partners).toEqual(["piano", "flute"]);
    expect(entry.tags).toContain("duo de flûtes");
    expect(xml).toContain("Flûte 1");
    expect(xml).not.toContain("Flûte 2");
    const split = splitAccompaniment(accompaniment!);
    expect(split.flute.map((n) => n.midi)).toEqual([65]); // Fa4 de la 2ᵉ flûte
    expect(split.piano.map((n) => n.midi)).toEqual([48]); // Do3 du piano
    const duo = prepareImport(trio.replace('<score-part id="P1"><part-name>Piano</part-name></score-part>', "").replace(/<part id="P1">[\s\S]*?<\/part>/, ""), "duo.xml");
    expect(duo.entry.partners).toEqual(["flute"]);
    expect(partnersOf(duo.entry)).toEqual(["flute"]);
    expect(partnersOf({ kind: "flute-piano" })).toEqual(["piano"]); // partitions importées avant les duos
  });

  it("deux flûtes sur une portée (deux voix) : la voix du haut pour l'élève, l'autre jouée par l'application", () => {
    const v = (step: string, octave: number, dur: number, voice: number) =>
      `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${dur}</duration><voice>${voice}</voice></note>`;
    const rest = (dur: number, voice: number) => `<note><rest/><duration>${dur}</duration><voice>${voice}</voice></note>`;
    const back = (dur: number) => `<backup><duration>${dur}</duration></backup>`;
    const xml = `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Flûtes</part-name></score-part></part-list>
<part id="P1">
<measure number="1"><attributes><divisions>1</divisions></attributes><sound tempo="60"/>${v("E", 5, 2, 1)}${v("G", 5, 2, 1)}${back(4)}${v("C", 5, 2, 2)}${v("E", 5, 2, 2)}</measure>
<measure number="2">${rest(4, 1)}${back(4)}${v("D", 5, 4, 2)}</measure>
<measure number="3">${v("C", 6, 4, 1)}</measure>
</part></score-partwise>`;
    const { entry, xml: mine, accompaniment, warnings } = prepareImport(xml, "duo-une-portee.xml");
    expect(warnings).toEqual([]); // plus de « plusieurs voix superposées »
    expect(entry.partners).toEqual(["flute"]);
    expect(entry.tags).toContain("duo de flûtes");
    // vous : la voix du haut (Mi5 Sol5, silence, Do6) ; le rythme et la durée du morceau sont gardés
    expect(melodyNotes(mine).length).toBe(3);
    expect(pianoNotes(mine).map((n) => [n.midi, n.startSec])).toEqual([[76, 0], [79, 2], [84, 8]]);
    // l'application : la voix du bas, au même tempo
    const { flute } = splitAccompaniment(accompaniment!);
    expect(flute.map((n) => [n.midi, n.startSec])).toEqual([[72, 0], [76, 2], [74, 4]]);
    // une 2ᵉ voix faite seulement de silences : retirée, sans 2ᵉ flûte ni avertissement
    const restsOnly = xml.replace(/<note><pitch><step>[CED]<\/step><octave>5<\/octave><\/pitch><duration>(\d)<\/duration><voice>2<\/voice><\/note>/g, "<note><rest/><duration>$1</duration><voice>2</voice></note>");
    const single = prepareImport(restsOnly, "x.xml");
    expect(single.warnings).toEqual([]);
    expect(single.entry.partners).toBeUndefined();
  });

  it("petite voix accidentelle (reconnaissance d'un PDF) : la mélodie reste à l'élève, entière", () => {
    const v = (step: string, octave: number, dur: number, voice: number) =>
      `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${dur}</duration><voice>${voice}</voice></note>`;
    const m = (n: number, body: string) => `<measure number="${n}">${n === 1 ? "<attributes><divisions>1</divisions></attributes>" : ""}${body}</measure>`;
    // voix 1 : 8 mesures de mélodie (grave) ; voix 2 : une seule mesure, seule et plus aiguë
    const body = [1, 2, 3, 5, 6, 7, 8].map((n) => m(n, v("C", 5, 2, 1) + v("D", 5, 2, 1))).join("");
    const xml = `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Flûte</part-name></score-part></part-list>
<part id="P1">${body.replace('<measure number="5">', `${m(4, v("A", 6, 2, 2) + v("B", 6, 2, 2))}<measure number="5">`)}</part></score-partwise>`;
    const { xml: mine, entry, warnings } = prepareImport(xml, "omr.xml");
    expect(entry.partners).toBeUndefined(); // pas de 2ᵉ flûte
    expect(warnings).toEqual([]);
    const notes = pianoNotes(mine).map((n) => n.midi);
    expect(notes).toHaveLength(16); // les 14 notes de la mélodie et les 2 de la mesure 4
    expect(notes.slice(6, 8)).toEqual([93, 95]);
  });

  it("partition reconnue depuis un PDF (parties « Voice » rangées différemment selon le système)", () => {
    const n = (step: string, octave: number, voice = 1) =>
      `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>1</duration><voice>${voice}</voice></note>`;
    const r = `<note><rest measure="yes"/><duration>4</duration><voice>1</voice></note>`;
    const m = (num: number, body: string, newSystem = false) =>
      `<measure number="${num}">${newSystem ? '<print new-system="yes"/>' : ""}${num === 1 ? "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>" : ""}${body}</measure>`;
    // système 1 (3 portées) : P1 vide, P2 = flûte, P3 = piano ; système 2 (4 portées) : P1 = flûte, P2 = piano m.d.
    const xml = `<?xml version="1.0"?><score-partwise><part-list>
<score-part id="P1"><part-name>Voice</part-name></score-part><score-part id="P2"><part-name>Voice</part-name></score-part>
<score-part id="P3"><part-name>Piano</part-name></score-part></part-list>
<part id="P1">${m(1, r)}${m(2, n("A", 5) + n("B", 5) + n("C", 6) + n("D", 6) + "<backup><duration>2</duration></backup>" + n("E", 4, 2), true)}</part>
<part id="P2">${m(1, n("C", 5) + n("D", 5) + n("E", 5) + n("F", 5))}${m(2, n("C", 4) + n("E", 4) + n("G", 4) + n("C", 4), true)}</part>
<part id="P3">${m(1, n("C", 3) + n("G", 3) + n("C", 3) + n("G", 3))}${m(2, r, true)}</part>
</score-partwise>`;
    const { entry, xml: mine, accompaniment, warnings } = prepareImport(xml, "omr.mxl");
    expect(entry.kind).toBe("flute-piano");
    // la flûte : P2 au 1er système, P1 au 2ᵉ (sans la petite voix 2 parasite)
    expect(pianoNotes(mine).map((x) => x.midi)).toEqual([72, 74, 76, 77, 81, 83, 84, 86]);
    expect(mine).not.toContain("Voice");
    // le piano : P3, plus P2 au 2ᵉ système (là où elle n'était plus la flûte)
    const piano = splitAccompaniment(accompaniment!).piano.map((x) => x.midi);
    expect(piano).toEqual(expect.arrayContaining([48, 55, 60, 64, 67]));
    expect(piano).not.toContain(72);
    expect(warnings).toContain("partition reconnue automatiquement : des notes ou des rythmes peuvent être faux, relisez-la");
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

describe("duo de flûtes reconnu depuis un PDF", () => {
  it("la 2ᵉ partie à une portée, dans l'aigu, devient la 2ᵉ flûte (pas un piano)", async () => {
    const { isFluteLike } = await import("../import");
    const part = (notes: string[], extra = "") =>
      new DOMParser().parseFromString(
        `<part id="P2"><measure number="1"><attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef>${extra}</attributes>${notes
          .map((p) => `<note><pitch><step>${p[0]}</step><octave>${p[1]}</octave></pitch><duration>1</duration></note>`)
          .join("")}</measure></part>`,
        "application/xml",
      ).documentElement;
    expect(isFluteLike(part(["E5", "D5", "C5", "B4", "A4", "G5"]))).toBe(true);
    expect(isFluteLike(part(["C4", "E4", "G4", "C4"]))).toBe(false); // main droite de piano, grave
    expect(isFluteLike(part(["C4", "E4", "G4", "C4"]), true)).toBe(true); // …mais aucune clé de fa : duo
    expect(isFluteLike(part(["E5", "D5", "C5", "B4"], "<staves>2</staves>"))).toBe(false);
    const bass = part(["E5", "D5", "C5", "B4"]);
    bass.querySelector("sign")!.textContent = "F";
    expect(isFluteLike(bass)).toBe(false);
  });
});
