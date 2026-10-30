import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../catalog";
import { groupHeadings, sortEntries } from "../sortScores";

const entry = (id: string, composer: string, level: CatalogEntry["level"], addedAt?: number): CatalogEntry => ({
  id,
  title: id,
  composer,
  level,
  complexity: level * 10,
  file: `${id}.musicxml`,
  source: "test",
  license: "Domaine public",
  origin: addedAt === undefined ? "native" : "import",
  addedAt,
});

const list = [
  entry("Menuet", "Bach", 3),
  entry("Syrinx", "Debussy", 5, 1000),
  entry("Au clair de la lune", "Traditionnel", 1),
  entry("Étude", "Kuhlau", 4, 3000),
  entry("Air", "bach", 2, 2000),
];

describe("sortEntries", () => {
  it("range par niveau par défaut", () => {
    expect(sortEntries(list, "level").map((e) => e.level)).toEqual([1, 2, 3, 4, 5]);
  });

  it("date d'import : importées les plus récentes d'abord, puis la bibliothèque", () => {
    expect(sortEntries(list, "recent").map((e) => e.id)).toEqual([
      "Étude",
      "Air",
      "Syrinx",
      "Au clair de la lune",
      "Menuet",
    ]);
  });

  it("compositeur puis titre, sans tenir compte des majuscules ni des accents", () => {
    expect(sortEntries(list, "composer").map((e) => e.id)).toEqual([
      "Air",
      "Menuet",
      "Syrinx",
      "Étude",
      "Au clair de la lune",
    ]);
    expect(sortEntries(list, "title").map((e) => e.id)).toEqual([
      "Air",
      "Au clair de la lune",
      "Étude",
      "Menuet",
      "Syrinx",
    ]);
  });

  it("ne modifie pas la liste reçue", () => {
    const before = list.map((e) => e.id);
    sortEntries(list, "title");
    expect(list.map((e) => e.id)).toEqual(before);
  });
});

describe("groupHeadings", () => {
  it("un en-tête par compositeur", () => {
    const sorted = sortEntries(list, "composer");
    expect(groupHeadings(sorted, "composer")).toEqual(["bach", null, "Debussy", "Kuhlau", "Traditionnel"]);
  });

  it("sépare les partitions importées de la bibliothèque", () => {
    const sorted = sortEntries(list, "recent");
    expect(groupHeadings(sorted, "recent")).toEqual(["Mes partitions importées", null, null, "Bibliothèque", null]);
  });

  it("pas d'en-tête pour le niveau et le titre", () => {
    expect(groupHeadings(list, "level").every((h) => h === null)).toBe(true);
  });
});
