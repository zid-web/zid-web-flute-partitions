import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../catalog";
import { availableEntries, planSync, signature } from "../contentSync";

const entry = (id: string, complexity = 10): CatalogEntry => ({
  id,
  title: id,
  composer: "C",
  level: 1,
  complexity,
  file: `${id}.musicxml`,
  source: "IMSLP",
  license: "Domaine public",
  origin: "native",
});

describe("synchronisation du contenu (applications natives)", () => {
  const bundled = [entry("a"), entry("b")];

  it("télécharge seulement les morceaux nouveaux ou modifiés", () => {
    const remote = [entry("a"), entry("b", 20), entry("c")];
    const plan = planSync(bundled, remote, {});
    expect(plan.download.map((e) => e.id)).toEqual(["b", "c"]);
    expect(plan.added.map((e) => e.id)).toEqual(["c"]);
  });

  it("ne retélécharge pas ce qui est déjà à jour sur l'appareil", () => {
    const remote = [entry("a"), entry("c")];
    const plan = planSync(bundled, remote, { c: signature(entry("c")), old: "x" });
    expect(plan.download).toEqual([]);
    expect(plan.removed).toEqual(["old"]);
  });

  it("n'affiche que les morceaux jouables hors ligne", () => {
    const remote = [entry("a"), entry("b", 20), entry("c")];
    // « b » modifié mais pas encore téléchargé, « c » téléchargé.
    const shown = availableEntries(bundled, remote, { c: signature(entry("c")) });
    expect(shown.map((e) => e.id)).toEqual(["a", "c"]);
  });
});
