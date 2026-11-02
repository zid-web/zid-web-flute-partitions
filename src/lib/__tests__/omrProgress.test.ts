import { describe, expect, it } from "vitest";
import { OMR_STEPS, OmrProgressTracker } from "../omrProgress";

const step = (book: string, sheet: number, s: string) => `INFO  [${book}#${sheet}]            StepMonitoring 98   | ${s}`;

describe("avancement de la reconnaissance d'un PDF (pages en parallèle)", () => {
  it("pages × étapes, plusieurs pages à la fois, jusqu'à l'écriture", () => {
    const t = new OmrProgressTracker();
    t.line("PAGE_START 1");
    expect(t.line("PAGES 2")?.label).toBe("2 pages à lire");
    expect(t.line("INFO  [deux] Book 560  | 2 sheets in /tmp/deux.pdf")?.pages).toBe(2);
    const first = t.line(step("deux", 1, "LOAD"))!;
    expect(first.fraction).toBeCloseTo(1 / 42, 9);
    expect(first.label).toBe("Page 1 sur 2 : ouverture de la page");
    t.line("PAGE_START 2");
    const both = t.line(step("deux", 2, "HEADS"))!;
    expect(both.label).toBe("Pages 1 et 2 en cours (0 sur 2 terminée) : têtes de notes");
    t.line("PAGE_DONE 1 ok");
    expect(t.line(step("deux", 2, "RHYTHMS"))!.label).toBe("Page 2 en cours (1 sur 2 terminée) : rythmes");
    expect(t.line("PAGE_DONE 2 ok")).toMatchObject({ fraction: 1, label: "Écriture de la partition (MusicXML)…" });
    expect(t.line("INFO  [deux] Book 2525 | Book stored as /tmp")).toBeNull();
  });

  it("ne recule jamais ; une page sautée compte comme terminée", () => {
    const t = new OmrProgressTracker();
    t.line("PAGES 3");
    t.line(step("x", 2, OMR_STEPS[19]));
    const before = t.progress.fraction;
    t.line(step("x", 1, "LOAD"));
    expect(t.progress.fraction).toBeGreaterThanOrEqual(before);
    t.line("PAGE_DONE 3 fail");
    expect(t.progress.fraction).toBeGreaterThan(1 / 3);
  });

  it("partition d'orchestre : signalée", () => {
    const t = new OmrProgressTracker();
    t.line("PAGES 40");
    expect(t.line("INFO [b#1] SystemManager 800 | 2 parts along 3 systems")).toBeNull();
    expect(t.line("INFO [b#1] SystemManager 800 | 18 parts along 1 systems")?.orchestra).toBe(18);
  });
});
