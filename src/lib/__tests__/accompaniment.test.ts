// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { keepParts, melodyNotes, pianoNotes, pianoPartIds } from "../accompaniment";

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

describe("ornements joués par le piano", () => {
  const piece = (body: string, fifths = 0) => `<?xml version="1.0"?><score-partwise><part-list>
<score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">
<measure number="1"><attributes><divisions>2</divisions><key><fifths>${fifths}</fifths></key></attributes><sound tempo="60"/>${body}</measure>
</part></score-partwise>`;
  const orn = (inner: string) => `<notations><ornaments>${inner}</ornaments></notations>`;

  it("trille : alternance avec la note du dessus dans la tonalité, sur toute la durée", () => {
    // La4 blanche en Fa majeur (si♭) : trille La / Si♭
    const notes = pianoNotes(piece(n("A", 4, 4, orn("<trill-mark/>")), -1));
    expect(new Set(notes.map((x) => x.midi))).toEqual(new Set([69, 70]));
    expect(notes[0].midi).toBe(69); // commence sur la note principale
    expect(notes.length % 2).toBe(0);
    expect(notes.length).toBeGreaterThanOrEqual(20); // ~14 notes par seconde sur 2 s
    const end = notes[notes.length - 1];
    expect(end.startSec + end.seconds).toBeCloseTo(2, 6); // dure toute la blanche
  });

  it("trille sur une note liée : dure toute la note liée", () => {
    const body = n("A", 4, 4, `<tie type="start"/>${orn("<trill-mark/>")}`) + n("A", 4, 4, '<tie type="stop"/>');
    const notes = pianoNotes(piece(body));
    const end = notes[notes.length - 1];
    expect(end.startSec + end.seconds).toBeCloseTo(4, 6);
    expect(notes.filter((x) => x.midi === 71).length).toBeGreaterThan(10); // La / Si
  });

  it("altération écrite sur la trille, mordant, mordant inversé, gruppetto", () => {
    const sharp = pianoNotes(piece(n("F", 4, 4, orn("<trill-mark/><accidental-mark>sharp</accidental-mark>"))));
    expect(new Set(sharp.map((x) => x.midi))).toEqual(new Set([65, 68])); // Fa / Sol♯
    expect(pianoNotes(piece(n("C", 5, 4, orn("<mordent/>")))).map((x) => x.midi)).toEqual([72, 71, 72]);
    expect(pianoNotes(piece(n("C", 5, 4, orn("<inverted-mordent/>")))).map((x) => x.midi)).toEqual([72, 74, 72]);
    expect(pianoNotes(piece(n("C", 5, 4, orn("<turn/>")))).map((x) => x.midi)).toEqual([74, 72, 71, 72]);
  });

  it("une note sans ornement ne change pas", () => {
    expect(pianoNotes(piece(n("C", 5, 4))).map((x) => [x.midi, x.seconds])).toEqual([[72, 2]]);
  });
});

describe("ornements de la mélodie (flûte, mode Écouter)", () => {
  it("une entrée par note attaquée : silences, notes liées, accords et appoggiatures ignorés", () => {
    const xml = `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Flûte</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>1</fifths></key></attributes>
${n("G", 4, 1)}<note><grace/><pitch><step>A</step><octave>4</octave></pitch></note>
${n("E", 5, 1, '<notations><ornaments><trill-mark/></ornaments></notations>')}${n("C", 5, 1, "<chord/>")}
<note><rest/><duration>1</duration></note>${n("A", 4, 1, '<tie type="start"/>')}</measure>
<measure number="2">${n("A", 4, 2, '<tie type="stop"/>')}${n("B", 4, 2, '<notations><ornaments><mordent/></ornaments></notations>')}</measure>
</part></score-partwise>`;
    const orns = melodyNotes(xml).map((m) => m.ornament);
    expect(orns.map((o) => o?.type ?? null)).toEqual([null, "trill", null, "mordent"]); // Sol, Mi (trille), La (lié), Si
    expect(orns[1]?.upper).toBe(78); // Mi5 → Fa♯5 en Sol majeur
    expect(orns[3]?.lower).toBe(69); // Si4 → La4
  });
});

describe("nuances, articulations et liaisons écrites", () => {
  const piece = (body: string) => `<?xml version="1.0"?><score-partwise><part-list>
<score-part id="P1"><part-name>Flûte</part-name></score-part></part-list><part id="P1">
<measure number="1"><attributes><divisions>1</divisions></attributes><sound tempo="60"/>${body}</measure>
</part></score-partwise>`;
  const dyn = (mark: string) => `<direction><direction-type><dynamics><${mark}/></dynamics></direction-type></direction>`;
  const wedge = (type: string) => `<direction><direction-type><wedge type="${type}"/></direction-type></direction>`;
  const art = (inner: string) => `<notations><articulations>${inner}</articulations></notations>`;

  it("staccato, staccatissimo, tenuto raccourcissent ou tiennent la note ; accent et marcato la renforcent", () => {
    const m = melodyNotes(piece(
      n("C", 5, 1, art("<staccato/>")) + n("D", 5, 1, art("<staccatissimo/>")) + n("E", 5, 1, art("<tenuto/>")) +
      n("F", 5, 1, art("<accent/>")) + n("G", 5, 1, art("<strong-accent/>")) + n("A", 5, 1),
    ));
    expect(m.map((x) => x.gate)).toEqual([0.5, 0.3, 1, undefined, undefined, undefined]);
    expect(m[3].velocity).toBeGreaterThan(m[5].velocity);
    expect(m[4].velocity).toBeGreaterThan(m[3].velocity);
  });

  it("nuances : p plus doux que f", () => {
    const m = melodyNotes(piece(dyn("p") + n("C", 5, 1) + dyn("f") + n("C", 5, 1)));
    expect(m[0].velocity).toBeLessThan(m[1].velocity);
  });

  it("soufflet crescendo : la force monte note après note jusqu'à la nuance d'arrivée", () => {
    const m = melodyNotes(piece(dyn("p") + wedge("crescendo") + n("C", 5, 1) + n("D", 5, 1) + n("E", 5, 1) + wedge("stop") + dyn("f") + n("F", 5, 1)));
    const v = m.map((x) => x.velocity);
    expect(v[0]).toBeLessThan(v[1]);
    expect(v[1]).toBeLessThan(v[2]);
    expect(v[2]).toBeCloseTo(v[3], 5); // arrive sur le f
  });

  it("diminuendo sans nuance d'arrivée : la force baisse", () => {
    const m = melodyNotes(piece(dyn("f") + wedge("diminuendo") + n("C", 5, 1) + n("D", 5, 1) + wedge("stop") + n("E", 5, 1)));
    expect(m[1].velocity).toBeLessThan(m[0].velocity);
    expect(m[2].velocity).toBeCloseTo(m[1].velocity, 5);
  });

  it("liaison d'expression : notes liées à la suivante, sauf la dernière de la liaison", () => {
    const slur = (type: string) => `<notations><slur type="${type}" number="1"/></notations>`;
    const m = melodyNotes(piece(n("C", 5, 1, slur("start")) + n("D", 5, 1) + n("E", 5, 1, slur("stop")) + n("F", 5, 1)));
    expect(m.map((x) => x.slurred)).toEqual([true, true, false, false]);
  });

  it("le piano raccourcit aussi ses notes staccato", () => {
    const notes = pianoNotes(piece(n("C", 4, 2, art("<staccato/>"))));
    expect(notes[0].gate).toBe(0.5);
    expect(notes[0].seconds).toBe(2); // durée écrite inchangée : c'est le jeu qui raccourcit
  });
});
