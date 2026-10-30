import { describe, expect, it } from "vitest";
import { BACKUP_FORMAT, parseBackup } from "../userScores";

const entry = { id: "import-abc", title: "Syrinx", composer: "Debussy", level: 5, complexity: 70, file: "s.mxl",
  source: "Importée sur cet appareil", license: "Fichier personnel", origin: "import" };

describe("sauvegarde des partitions importées", () => {
  it("relit une sauvegarde valide", () => {
    const text = JSON.stringify({ format: BACKUP_FORMAT, version: 1,
      scores: [{ entry, xml: "<score-partwise/>", addedAt: 1000 }, { entry: { id: 3 }, xml: "x" }] });
    const scores = parseBackup(text);
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ entry: { id: "import-abc", origin: "import" }, addedAt: 1000 });
  });

  it("refuse un fichier qui n'est pas une sauvegarde", () => {
    expect(() => parseBackup("pas du json")).toThrow(/sauvegarde/);
    expect(() => parseBackup(JSON.stringify({ format: "autre", scores: [] }))).toThrow(/sauvegarde/);
  });
});
