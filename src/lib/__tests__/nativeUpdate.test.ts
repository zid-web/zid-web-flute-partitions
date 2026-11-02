import { describe, expect, it } from "vitest";
import { downloadFraction } from "../nativeUpdate";

describe("mise à jour de l'application de bureau", () => {
  it("avancement du téléchargement", () => {
    expect(downloadFraction(5, 10)).toBe(0.5);
    expect(downloadFraction(12, 10)).toBe(1);
    expect(downloadFraction(5, undefined)).toBeNull();
    expect(downloadFraction(5, 0)).toBeNull();
  });
});
