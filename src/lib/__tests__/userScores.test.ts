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

describe("sauvegarde des notes de « Ma flûte »", () => {
  it("une note encodée puis relue garde son son (16 bits), sa justesse et sa hauteur", async () => {
    const { decodeTake, encodeTake } = await import("../myFlute");
    const pcm = new Float32Array(4800).map((_, i) => 0.5 * Math.sin(i / 10));
    const back = decodeTake(JSON.parse(JSON.stringify(encodeTake({ midi: 69, sampleRate: 48000, pcm, cents: -7, recordedAt: 42 }))));
    expect(back).toMatchObject({ midi: 69, sampleRate: 48000, cents: -7, recordedAt: 42 });
    expect(back!.pcm).toHaveLength(4800);
    expect(Math.max(...back!.pcm.map((v, i) => Math.abs(v - pcm[i])))).toBeLessThan(1e-4);
  });

  it("ignore une note abîmée ou qui n'est pas à enregistrer ; ancienne sauvegarde sans notes", async () => {
    const { parseBackupTakes } = await import("../userScores");
    const { encodeTake } = await import("../myFlute");
    const ok = encodeTake({ midi: 60, sampleRate: 44100, pcm: new Float32Array(10), cents: 0, recordedAt: 1 });
    const text = JSON.stringify({ format: BACKUP_FORMAT, version: 2, scores: [],
      takes: [ok, { ...ok, midi: 61 }, { ...ok, pcm16: "%%%" }, { ...ok, sampleRate: 5 }, null] });
    expect(parseBackupTakes(text).map((t) => t.midi)).toEqual([60]);
    expect(parseBackupTakes(JSON.stringify({ format: BACKUP_FORMAT, version: 1, scores: [] }))).toEqual([]);
  });
});
