import { describe, expect, it } from "vitest";
import { OMR_STEPS, OmrProgressTracker } from "../omrProgress";

const step = (book: string, sheet: number, s: string) => `INFO  [${book}#${sheet}]            StepMonitoring 98   | ${s}`;

describe("avancement de la reconnaissance d'un PDF (journal d'Audiveris)", () => {
  it("pages × étapes, jusqu'à l'export", () => {
    const t = new OmrProgressTracker();
    expect(t.line("INFO  [deux]                      Book 560  | 2 sheets in /tmp/deux.pdf")?.label).toBe("2 pages à lire");
    t.line("INFO  []                      Book 1929 | Book reaching PAGE on sheets:[#1#2]");
    const first = t.line(step("deux", 1, "LOAD"))!;
    expect(first.fraction).toBeCloseTo(1 / 40, 9);
    expect(first.label).toBe("Page 1 sur 2 : ouverture de la page");
    const half = t.line(step("deux", 1, "PAGE"))!;
    expect(half.fraction).toBeCloseTo(0.5, 9);
    expect(t.line(step("deux", 2, "RHYTHMS"))!.label).toBe("Page 2 sur 2 : rythmes");
    expect(t.line("INFO  [deux]  PartwiseBuilder 2707 | Exporting sheet(s): [#1#2]")).toMatchObject({
      fraction: 1,
      label: "Écriture de la partition (MusicXML)…",
    });
    expect(t.line("INFO  [deux] Book 2525 | Book stored as /tmp")).toBeNull();
  });

  it("ne recule jamais, même si une page est traitée hors ordre", () => {
    const t = new OmrProgressTracker();
    t.line("3 sheets in x.pdf");
    t.line(step("x", 2, OMR_STEPS[19]));
    const before = t.progress.fraction;
    t.line(step("x", 1, "LOAD"));
    expect(t.progress.fraction).toBe(before);
  });

  it("reprise page par page (RUN n/total)", () => {
    const t = new OmrProgressTracker();
    t.line("9 sheets in x.pdf"); // premier essai : échec à l'export
    t.line("RUN 3/9");
    t.line("Book reaching PAGE on sheets:[#3]");
    const p = t.line(step("x", 3, "PAGE"))!;
    expect(p.fraction).toBeCloseTo(3 / 9, 9);
    expect(p.label).toBe("Page 3 sur 9 : fin de la page");
  });
});
