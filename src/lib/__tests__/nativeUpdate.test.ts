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

describe("échec de mise à jour : un message utile", () => {
  it("application lancée depuis le .dmg ou isolée par macOS", async () => {
    const { locationProblem } = await import("../nativeUpdate");
    expect(locationProblem("/Volumes/Flûte Partitions/Flûte Partitions.app/Contents/MacOS/flute-partitions")).toMatch(/image disque/);
    expect(locationProblem("/private/var/folders/x/AppTranslocation/AB12/d/Flûte Partitions.app/Contents/MacOS/flute-partitions")).toMatch(/Applications/);
    expect(locationProblem("/Applications/Flûte Partitions.app/Contents/MacOS/flute-partitions")).toBeNull();
    expect(locationProblem(null)).toBeNull();
  });

  it("erreurs connues traduites, sinon le message d'origine", async () => {
    const { updateErrorMessage } = await import("../nativeUpdate");
    expect(updateErrorMessage(new Error("Read-only file system (os error 30)"))).toMatch(/lecture seule/);
    expect(updateErrorMessage("Permission denied (os error 13)")).toMatch(/autorisation/);
    expect(updateErrorMessage("error sending request for url")).toMatch(/connexion/);
    expect(updateErrorMessage("quelque chose d'inattendu")).toBe("La mise à jour n'a pas pu être installée (quelque chose d'inattendu).");
  });
});
