// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { assembleOmrPages, mergeScorePages, splitAtFinalBarlines, startsIndented } from "../omrPages";

const note = (step: string) => `<note><pitch><step>${step}</step><octave>5</octave></pitch><duration>4</duration></note>`;
const page = (parts: string[][]) => `<?xml version="1.0"?><score-partwise><part-list>${parts
  .map((_, i) => `<score-part id="P${i + 1}"><part-name>Voice</part-name></score-part>`)
  .join("")}</part-list>${parts
  .map((ms, i) => `<part id="P${i + 1}">${ms.map((m, k) => `<measure number="${k + 1}" width="200">${k === 0 ? "<attributes><divisions>4</divisions></attributes>" : ""}${note(m)}</measure>`).join("")}</part>`)
  .join("")}</score-partwise>`;

const doc = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");
const steps = (xml: string, part: number) =>
  Array.from(doc(xml).querySelectorAll("part")[part].querySelectorAll("measure")).map((m) => m.querySelector("step")?.textContent ?? "-");

describe("pages reconnues séparément, rassemblées", () => {
  it("met les pages bout à bout, partie par partie, mesures renumérotées, nouvelle page marquée", () => {
    const xml = mergeScorePages([page([["C", "D"], ["E", "F"]]), page([["G"], ["A"]])]);
    expect(steps(xml, 0)).toEqual(["C", "D", "G"]);
    expect(steps(xml, 1)).toEqual(["E", "F", "A"]);
    const measures = Array.from(doc(xml).querySelectorAll("part")[0].querySelectorAll("measure"));
    expect(measures.map((m) => m.getAttribute("number"))).toEqual(["1", "2", "3"]);
    expect(measures[2].querySelector("print")?.getAttribute("new-page")).toBe("yes");
    expect(measures[0].querySelector("print")).toBeNull();
  });

  it("une partie absente d'une page y reçoit des mesures vides ; la liste des parties la plus complète est gardée", () => {
    const xml = mergeScorePages([page([["C", "D"]]), page([["G"], ["A"], ["B"]])]);
    expect(doc(xml).querySelectorAll("score-part")).toHaveLength(3);
    expect(steps(xml, 0)).toEqual(["C", "D", "G"]);
    expect(steps(xml, 2)).toEqual(["-", "-", "B"]);
  });

  it("morceaux : les pages se suivent ; un mouvement qui commence au milieu d'une page en crée un nouveau", () => {
    const pieces = assembleOmrPages([
      { name: "p002~Sonate.mxl", xml: page([["D"]]) },
      { name: "p001~Sonate.mxl", xml: page([["C"]]) },
      { name: "p003~Sonate.mvt1.mxl", xml: page([["E"]]) },
      { name: "p003~Sonate.mvt2.mxl", xml: page([["F"]]) },
      { name: "p004~Sonate.mxl", xml: page([["G"]]) },
    ]);
    expect(pieces.map((p) => [p.suffix, p.pages])).toEqual([
      [".mvt1", [1, 2, 3]],
      [".mvt2", [3, 4]],
    ]);
    expect(steps(pieces[0].xml, 0)).toEqual(["C", "D", "E"]);
    expect(steps(pieces[1].xml, 0)).toEqual(["F", "G"]);
  });
});

describe("recueil de plusieurs morceaux (ex. Three Christmas Carols)", () => {
  // une page = un morceau ; `final` : barre finale à la fin ; `indent` : premier système en retrait
  const sys = (left: number) => `<print new-system="yes"><system-layout><system-margins><left-margin>${left}</left-margin></system-margins></system-layout></print>`;
  const piece = (steps: string[], { final = false, indent = false } = {}) =>
    `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list><part id="P1">${steps
      .map(
        (st, k) =>
          `<measure number="${k + 1}">${k === 0 ? `<print><system-layout><system-margins><left-margin>${indent ? 90 : 60}</left-margin></system-margins></system-layout></print><attributes><divisions>4</divisions><key><fifths>1</fifths></key><clef><sign>G</sign><line>2</line></clef></attributes>` : k === 2 ? sys(60) : ""}${note(st)}${final && k === steps.length - 1 ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>' : ""}</measure>`,
      )
      .join("")}</part></score-partwise>`;

  it("barre finale en bas de page : la page suivante est un autre morceau", () => {
    const pieces = assembleOmrPages([
      { name: "p001~Noels.mxl", xml: piece(["C", "D", "E", "F"], { final: true }) },
      { name: "p002~Noels.mxl", xml: piece(["G", "A", "B"]) },
    ]);
    expect(pieces.map((p) => p.pages)).toEqual([[1], [2]]);
  });

  it("premier système en retrait : nouveau morceau, même sans barre finale reconnue", () => {
    const pieces = assembleOmrPages([
      { name: "p001~Noels.mxl", xml: piece(["C", "D", "E"]) },
      { name: "p002~Noels.mxl", xml: piece(["G", "A", "B"], { indent: true }) },
      { name: "p003~Noels.mxl", xml: piece(["E", "F", "G"]) }, // suite du 2ᵉ morceau
    ]);
    expect(pieces.map((p) => p.pages)).toEqual([[1], [2, 3]]);
    expect(startsIndented(piece(["C", "D", "E"], { indent: true }))).toBe(true);
    expect(startsIndented(piece(["C", "D", "E"]))).toBe(false);
  });

  it("barre finale en milieu de page, en fin de système : la page est coupée, clé et armure recopiées", () => {
    const xml = piece(["C", "D", "E", "F"]).replace("</note></measure><measure number=\"3\">", '</note><barline location="right"><bar-style>light-heavy</bar-style></barline></measure><measure number="3">');
    const chunks = splitAtFinalBarlines(xml);
    expect(chunks).toHaveLength(2);
    expect(steps(chunks[0], 0)).toEqual(["C", "D"]);
    expect(steps(chunks[1], 0)).toEqual(["E", "F"]);
    const second = doc(chunks[1]).querySelector("measure")!;
    expect(second.getAttribute("number")).toBe("1");
    expect(second.querySelector("attributes > divisions")?.textContent).toBe("4");
    expect(second.querySelector("attributes > key > fifths")?.textContent).toBe("1");
    expect(second.querySelector("attributes > clef > sign")?.textContent).toBe("G");
    expect(assembleOmrPages([{ name: "p001~Noels.mxl", xml }])).toHaveLength(2);
  });

  it("une reprise (barre finale suivie d'un début de reprise) ne coupe pas le morceau", () => {
    const xml = piece(["C", "D", "E", "F"])
      .replace("</note></measure><measure number=\"3\">", '</note><barline location="right"><bar-style>light-heavy</bar-style></barline></measure><measure number="3"><barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>');
    expect(splitAtFinalBarlines(xml)).toHaveLength(1);
  });
});
