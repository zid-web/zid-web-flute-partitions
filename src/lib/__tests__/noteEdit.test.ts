// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyNoteEdit, canEditNote, midiOf, type NoteRef } from "../noteEdit";

const n = (step: string, octave: number, extra = "", alter = 0) =>
  `<note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch><duration>1</duration>${extra}</note>`;
const rest = `<note><rest/><duration>1</duration></note>`;
const piece = (...measures: string[]) => `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Flûte</part-name></score-part><score-part id="P2"><part-name>Piano</part-name></score-part></part-list>
<part id="P1">${measures.map((b, i) => `<measure number="${i + 1}">${i === 0 ? "<attributes><divisions>1</divisions></attributes>" : ""}${b}</measure>`).join("")}</part>
<part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes>${n("C", 3)}</measure></part></score-partwise>`;

/** Hauteurs des notes de la flûte (première partie), silences exclus, dans l'ordre du fichier. */
const midis = (xml: string) => {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return Array.from(doc.querySelector("part")!.getElementsByTagName("note"))
    .map(midiOf)
    .filter((m) => m !== null);
};
const at = (measure: number, beatInMeasure: number, midi: number): NoteRef => ({ measure, beatInMeasure, midi });

describe("correction d'une note", () => {
  // mesure 1 : Do5 (silence) Mi5 Sol5 ; mesure 2 : La5 liée sur La5, Si5, Do6
  const xml = piece(n("C", 5) + rest + n("E", 5) + n("G", 5, "<stem>up</stem>"), n("A", 5, '<tie type="start"/>') + n("A", 5, '<tie type="stop"/>') + n("B", 5) + n("C", 6));

  it("la note touchée est retrouvée par mesure, position et hauteur", () => {
    expect(canEditNote(xml, at(0, 2, 76))).toBe(true);
    expect(canEditNote(xml, at(0, 2, 77))).toBe(false); // autre hauteur
    expect(canEditNote(xml, at(0, 1, 76))).toBe(false); // un silence à cette place
    expect(canEditNote(xml, at(1, 1, 81))).toBe(true); // note liée affichée comme une attaque (liaison mal reconnue)
  });

  it("demi-ton : dièse en montant, bémol en descendant, altération et hampe recalculées", () => {
    const up = applyNoteEdit(xml, at(0, 0, 72), { kind: "semitone", by: 1 })!;
    expect(up.midi).toBe(73);
    expect(up.xml).toContain("<step>C</step><alter>1</alter><octave>5</octave>");
    const down = applyNoteEdit(xml, at(0, 3, 79), { kind: "semitone", by: -1 })!;
    expect(down.xml).toContain("<step>G</step><alter>-1</alter><octave>5</octave>");
    expect(down.xml).not.toContain("<stem>");
    // Si → Do : changement d'octave dans l'écriture
    const b = applyNoteEdit(xml, at(1, 2, 83), { kind: "semitone", by: 1 })!;
    expect(midis(b.xml)).toEqual([72, 76, 79, 81, 81, 84, 84]);
  });

  it("une note liée change avec la note qui l'attaque", () => {
    const r = applyNoteEdit(xml, at(1, 0, 81), { kind: "octave", by: -1 })!;
    expect(r.midi).toBe(69);
    expect(midis(r.xml)).toEqual([72, 76, 79, 69, 69, 83, 84]);
  });

  it("silence : la note (et sa note liée) devient un silence de même durée", () => {
    const r = applyNoteEdit(xml, at(1, 0, 81), { kind: "rest" })!;
    expect(r.midi).toBeNull();
    expect(midis(r.xml)).toEqual([72, 76, 79, 83, 84]);
    expect(r.xml).not.toContain("<tie");
    expect((r.xml.match(/<rest\/>/g) ?? []).length).toBe(3);
  });

  it("accord : en silence, l'autre note de l'accord reste", () => {
    const chord = piece(n("C", 5) + n("E", 5, "<chord/>") + n("D", 5) + n("F", 5));
    expect(midis(applyNoteEdit(chord, at(0, 0, 76), { kind: "rest" })!.xml)).toEqual([72, 74, 77]);
    const head = piece(n("E", 5) + n("C", 5, "<chord/>") + n("D", 5) + n("F", 5));
    const r = applyNoteEdit(head, at(0, 0, 76), { kind: "rest" })!.xml;
    expect(midis(r)).toEqual([72, 74, 77]);
    expect(r).not.toContain("<chord/>");
  });

  it("plusieurs voix : la position compte, pas l'ordre du fichier", () => {
    const two = piece(n("C", 5) + n("D", 5) + `<backup><duration>2</duration></backup>` + n("G", 5) + n("A", 5));
    const r = applyNoteEdit(two, at(0, 1, 74), { kind: "semitone", by: -1 })!;
    expect(midis(r.xml)).toEqual([72, 73, 79, 81]);
  });

  it("note introuvable : rien", () => {
    expect(applyNoteEdit(xml, at(5, 0, 72), { kind: "semitone", by: 1 })).toBeNull();
  });
});
