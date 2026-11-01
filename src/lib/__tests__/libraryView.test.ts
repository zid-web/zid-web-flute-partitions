import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../catalog";
import { groupWorks, movementLabel } from "../libraryView";

const e = (id: string, extra: Partial<CatalogEntry>): CatalogEntry => ({
  id, title: id, composer: "Handel", level: 3, complexity: 40, file: `${id}.mxl`, source: "", license: "", origin: "import", ...extra,
});

describe("bibliothèque : œuvres en plusieurs mouvements", () => {
  const all = [
    e("solo", { title: "Syrinx", composer: "Debussy" }),
    e("m2", { title: "Sonate en mi – Adagio", work: "Sonate en mi", movement: 2 }),
    e("m1", { title: "Sonate en mi – Allegro", work: "Sonate en mi", movement: 1 }),
  ];

  it("une seule carte pour l'œuvre, à la place de son premier mouvement affiché, mouvements dans l'ordre", () => {
    const items = groupWorks([all[1], all[0], all[2]], all);
    expect(items.map((i) => i.title)).toEqual(["Sonate en mi", "Syrinx"]);
    expect(items[0].entries.map((x) => x.id)).toEqual(["m1", "m2"]);
  });

  it("filtre : seuls les mouvements affichés sont dans la carte ; un seul → carte simple", () => {
    const items = groupWorks([all[1]], all);
    expect(items).toEqual([{ key: "m2", entries: [all[1]], title: "Sonate en mi – Adagio" }]);
  });

  it("titre du mouvement dans la carte", () => {
    expect(movementLabel(all[2], "Sonate en mi", 0)).toBe("1. Allegro");
    expect(movementLabel(e("x", { title: "Sonate en mi" }), "Sonate en mi", 1)).toBe("2. Mouvement 2");
  });
});
