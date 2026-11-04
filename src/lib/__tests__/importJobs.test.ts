import { beforeEach, describe, expect, it, vi } from "vitest";

// Import simulé : chaque fichier « lu » attend qu'on le libère, pour observer la file d'attente.
const gates = new Map<string, () => void>();
vi.mock("../import", () => ({
  readScoreFile: (f: File) => new Promise<string>((r) => gates.set(f.name, () => r(f.name))),
  readScoreBytes: async () => "",
  prepareImport: (xml: string, name: string) => ({ entry: { id: name, title: xml }, xml, warnings: [] }),
}));
vi.mock("../userScores", () => ({ saveUserScore: async (entry: object) => ({ ...entry, addedAt: 1 }) }));
vi.mock("../pdfImport", () => ({ isPdf: () => false, convertPdf: vi.fn(), cancelPdf: vi.fn() }));

const flush = () => new Promise((r) => setTimeout(r, 0));
const file = (name: string) => ({ name }) as File;

describe("import en arrière-plan", () => {
  beforeEach(() => vi.resetModules());

  it("continue sans écran ; les fichiers ajoutés pendant l'import attendent leur tour", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const jobs = await import("../importJobs");
    const imported: string[] = [];
    jobs.onScoreImported((e) => imported.push(e.id));
    jobs.startImport([file("a.mxl")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.getImportStatus()).toMatchObject({ kind: "busy", file: "a.mxl", index: 1, count: 1 });
    jobs.startImport([file("b.mxl")]); // pendant l'import
    expect(jobs.getImportStatus()).toMatchObject({ kind: "busy", file: "a.mxl", count: 2 });
    gates.get("a.mxl")!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(imported).toEqual(["a.mxl"]);
    expect(jobs.getImportStatus()).toMatchObject({ kind: "busy", file: "b.mxl", index: 2, count: 2 });
    gates.get("b.mxl")!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(imported).toEqual(["a.mxl", "b.mxl"]);
    const done = jobs.getImportStatus();
    expect(done.kind).toBe("done");
    expect(done.kind === "done" && done.results.map((r) => r.file)).toEqual(["a.mxl", "b.mxl"]);
    jobs.dismissImportResults();
    expect(jobs.getImportStatus().kind).toBe("idle");
    vi.useRealTimers();
  });

  it("annuler vide la file d'attente", async () => {
    const jobs = await import("../importJobs");
    jobs.startImport([file("c.mxl"), file("d.mxl")]);
    await flush();
    jobs.cancelImport();
    expect(jobs.getImportStatus()).toMatchObject({ kind: "busy", cancelling: true });
    gates.get("c.mxl")!();
    await new Promise((r) => setTimeout(r, 700));
    const s = jobs.getImportStatus();
    expect(s.kind === "done" && s.results.map((r) => r.file)).toEqual(["c.mxl"]);
    expect(gates.has("d.mxl")).toBe(false);
  });
});
