// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { assembleOmrPages, mergeScorePages } from "../omrPages";

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
      ["", [1, 2, 3]],
      [".mvt2", [3, 4]],
    ]);
    expect(steps(pieces[0].xml, 0)).toEqual(["C", "D", "E"]);
    expect(steps(pieces[1].xml, 0)).toEqual(["F", "G"]);
  });
});
