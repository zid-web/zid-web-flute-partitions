// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../catalog";
import { foldToFluteRange, octaveShift } from "../fluteRange";
import { prepareImport } from "../import";
import { leadingNumber, movementFromName, movementsOf } from "../movements";
import { withPlayableOctaves } from "../catalog";

const note = (step: string, octave: number, alter = 0) =>
  `<note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch><duration>1</duration><stem>up</stem></note>`;
const flute = (notes: string, head = "") => `<?xml version="1.0"?><score-partwise>${head}<part-list>
<score-part id="P1"><part-name>Flûte</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>${notes}</measure></part></score-partwise>`;

describe("tessiture de la flûte", () => {
  it("décalage d'octave : Mi3 monte, Mi7 descend, Do4 et Ré7 restent", () => {
    expect(octaveShift(52)).toBe(1); // Mi3 → Mi4
    expect(octaveShift(40)).toBe(2); // Mi2 → Mi4
    expect(octaveShift(100)).toBe(-1); // Mi7 → Mi6
    expect(octaveShift(60)).toBe(0);
    expect(octaveShift(98)).toBe(0);
    expect(octaveShift(59)).toBe(0); // Si3, patte de si
  });

  it("ramène les notes injouables et compte les notes changées", () => {
    const doc = new DOMParser().parseFromString(flute(note("E", 3) + note("A", 4) + note("B", 2, -1) + note("E", 7)), "application/xml");
    expect(foldToFluteRange(doc.querySelector("part")!)).toBe(3);
    expect(Array.from(doc.querySelectorAll("octave")).map((o) => o.textContent)).toEqual(["4", "4", "4", "6"]);
    expect(doc.querySelectorAll("stem")).toHaveLength(1); // hampes forcées retirées des notes déplacées
  });

  it("à l'import : plus d'avertissement de tessiture, mais un message sur les notes corrigées", () => {
    const { xml, entry, warnings } = prepareImport(flute(note("E", 3) + note("G", 4) + note("F", 6, 1)), "x.musicxml");
    expect(entry.range).toEqual({ low: "Mi4", high: "Fa♯6" });
    expect(warnings).toEqual(["1 note hors de la tessiture de la flûte a été ramenée à l'octave jouable"]);
    expect(xml).toContain("<octave>4</octave>");
  });

  it("partition déjà importée : corrigée à l'ouverture", () => {
    const xml = flute(note("E", 3));
    expect(withPlayableOctaves(xml)).toContain("<octave>4</octave>");
    const ok = flute(note("E", 4));
    expect(withPlayableOctaves(ok)).toBe(ok);
  });
});

describe("mouvements d'une œuvre", () => {
  it("numéro de mouvement d'après le nom du fichier", () => {
    expect(movementFromName("Sonate.mvt2.mxl")).toEqual({ work: "Sonate", number: 2 });
    expect(movementFromName("Suite en si - Mouvement III.musicxml")).toEqual({ work: "Suite en si", number: 3 });
    expect(movementFromName("Handel sonata_3.mxl")).toEqual({ work: "Handel sonata", number: 3 });
    expect(movementFromName("Sonate op. 2.mxl")).toBeNull();
    expect(movementFromName("Partita BWV 1013.mxl")).toBeNull();
    expect(movementFromName("Syrinx.mxl")).toBeNull();
  });

  it("numéro en tête du titre de mouvement", () => {
    expect(leadingNumber("II. Allegro")).toBe(2);
    expect(leadingNumber("3 - Presto")).toBe(3);
    expect(leadingNumber("Vivace")).toBeNull();
    expect(leadingNumber("Allegro")).toBeNull();
  });

  it("import : titre d'œuvre + titre et numéro de mouvement", () => {
    const head = "<work><work-title>Sonate en mi mineur</work-title></work><movement-number>2</movement-number><movement-title>Allegro</movement-title>";
    const { entry } = prepareImport(flute(note("A", 4), head), "sonate.mxl");
    expect(entry.title).toBe("Sonate en mi mineur – Allegro");
    expect(entry).toMatchObject({ work: "Sonate en mi mineur", movement: 2 });
  });

  const e = (id: string, extra: Partial<CatalogEntry>): CatalogEntry => ({
    id,
    title: id,
    composer: "Handel",
    level: 3,
    complexity: 40,
    file: `${id}.mxl`,
    source: "",
    license: "",
    origin: "import",
    ...extra,
  });

  it("enchaîne les mouvements dans l'ordre, même importés dans le désordre", () => {
    const all = [
      e("c", { work: "Sonate", movement: 3, addedAt: 1 }),
      e("a", { work: "Sonate", movement: 1, addedAt: 3 }),
      e("autre", { work: "Sonate", movement: 2, composer: "Bach" }),
      e("b", { file: "Sonate.mvt2.mxl", addedAt: 2 }),
      e("seul", {}),
    ];
    expect(movementsOf(all[1], all).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(movementsOf(all[4], all).map((x) => x.id)).toEqual(["seul"]);
  });

  it("sans numéro : même titre et fichiers différents, dans l'ordre des fichiers ; pas un doublon", () => {
    const parts = [e("p2", { title: "Sonate", file: "sonate (2).mxl" }), e("p1", { title: "Sonate", file: "sonate (1).mxl" })];
    expect(movementsOf(parts[0], parts).map((x) => x.id)).toEqual(["p1", "p2"]);
    const twice = [e("d1", { title: "Syrinx", file: "syrinx.mxl" }), e("d2", { title: "Syrinx", file: "syrinx.mxl" })];
    expect(movementsOf(twice[0], twice)).toHaveLength(1);
  });

  it("la bibliothèque ne se mélange pas aux partitions importées", () => {
    const all = [e("i", { work: "Sonate", movement: 1 }), e("lib", { work: "Sonate", movement: 2, origin: "native" })];
    expect(movementsOf(all[0], all)).toHaveLength(1);
  });
});
