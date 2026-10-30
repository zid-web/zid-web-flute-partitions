// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { keepParts, pianoNotes, pianoPartIds } from "../accompaniment";

const n = (step: string, octave: number, dur: number, extra = "") =>
  `<note>${extra.includes("<chord/>") ? "<chord/>" : ""}<pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${dur}</duration>${extra.replace("<chord/>", "")}</note>`;
const rest = (dur: number) => `<note><rest/><duration>${dur}</duration></note>`;

/** Flûte + piano (deux portées, voix séparées par <backup>), ♩ = 60 : 1 noire = 1 s. */
const DUO = `<?xml version="1.0"?><score-partwise><part-list>
<score-part id="P1"><part-name>Flûte</part-name></score-part>
<score-part id="P2"><part-name>Piano</part-name></score-part></part-list>
<part id="P1">
<measure number="1"><attributes><divisions>2</divisions></attributes><sound tempo="60"/>${n("A", 5, 8)}</measure>
<measure number="2">${n("B", 5, 8)}</measure></part>
<part id="P2">
<measure number="1"><attributes><divisions>2</divisions><staves>2</staves></attributes>
<direction><direction-type><dynamics><p/></dynamics></direction-type></direction>
${n("C", 5, 4)}${n("E", 5, 4, "<chord/>")}${n("G", 5, 4, '<tie type="start"/>')}
<backup><duration>8</duration></backup>${n("C", 3, 8)}</measure>
<measure number="2">${n("G", 5, 2, '<tie type="stop"/>')}${rest(2)}
<direction><direction-type><dynamics><f/></dynamics></direction-type></direction>${n("D", 5, 4)}
<backup><duration>8</duration></backup>${n("G", 2, 8)}</measure></part>
</score-partwise>`;

const doc = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");

describe("repérage des parties de piano", () => {
  it("par le nom d'instrument, ou deux portées ; jamais la flûte", () => {
    expect(pianoPartIds(doc(DUO))).toEqual(["P2"]);
    const unnamed = DUO.replace("<part-name>Piano</part-name>", "<part-name>Voice</part-name>");
    expect(pianoPartIds(doc(unnamed))).toEqual(["P2"]); // deux portées
    const harpsichord = DUO.replace("<part-name>Piano</part-name>", "<part-name>Clavecin</part-name>").replace("<staves>2</staves>", "");
    expect(pianoPartIds(doc(harpsichord))).toEqual(["P2"]);
  });

  it("keepParts ne garde que le piano", () => {
    const d = doc(DUO);
    keepParts(d, ["P2"]);
    const xml = new XMLSerializer().serializeToString(d);
    expect(xml).not.toContain("Flûte");
    expect(d.getElementsByTagName("part")).toHaveLength(1);
  });
});

describe("notes du piano", () => {
  const notes = pianoNotes(DUO, ["P2"]);
  const at = (sec: number) => notes.filter((x) => Math.abs(x.startSec - sec) < 1e-9).map((x) => x.midi);

  it("accords et deux portées jouent ensemble, au tempo de la partition", () => {
    expect(at(0)).toEqual([48, 72, 76]); // basse Do3 + accord Do-Mi
    expect(at(2)).toEqual([79]); // puis Sol5 (lié), 2 noires plus tard
    expect(notes.find((x) => x.midi === 48)?.seconds).toBe(4); // ronde = 4 s à ♩ = 60
  });

  it("une note liée n'est pas refrappée : elle est prolongée", () => {
    const sol = notes.filter((x) => x.midi === 79);
    expect(sol).toHaveLength(1);
    expect(sol[0].seconds).toBe(3); // blanche + noire liées
  });

  it("silence, puis note de la mesure 2 au bon instant, et nuances p → f", () => {
    expect(at(6)).toEqual([74]);
    expect(notes.find((x) => x.midi === 72)?.velocity).toBeLessThan(notes.find((x) => x.midi === 74)!.velocity);
    expect(at(4)).toEqual([43]); // basse de la mesure 2
  });

  it("suit les changements de tempo", () => {
    const faster = DUO.replace('<measure number="2">' + n("B", 5, 8), '<measure number="2"><sound tempo="120"/>' + n("B", 5, 8));
    const d = pianoNotes(faster, ["P2"]);
    expect(d.find((x) => x.midi === 74)?.startSec).toBe(5); // mesure 2 à ♩ = 120 : 2 noires = 1 s
  });
});
