/**
 * Doigtés de base de la flûte traversière Boehm (deux premières octaves).
 * Clés : pouce gauche (LT), index/majeur/annulaire gauche (L1–L3),
 * petit doigt gauche sol♯ (Gis), main droite (R1–R3), petit doigt droit mi♭ (Eb),
 * et clés de patte do / do♯ (C, Cis).
 */
export type Key = "LT" | "L1" | "L2" | "L3" | "Gis" | "R1" | "R2" | "R3" | "Eb" | "Cis" | "C";

const LOW: Record<number, Key[]> = {
  0: ["LT", "L1", "L2", "L3", "R1", "R2", "R3", "C"], // Do
  1: ["LT", "L1", "L2", "L3", "R1", "R2", "R3", "Cis"], // Do♯
  2: ["LT", "L1", "L2", "L3", "R1", "R2", "R3"], // Ré
  3: ["LT", "L1", "L2", "L3", "R1", "R2", "R3", "Eb"], // Mi♭
  4: ["LT", "L1", "L2", "L3", "R1", "R2", "Eb"], // Mi
  5: ["LT", "L1", "L2", "L3", "R1", "Eb"], // Fa
  6: ["LT", "L1", "L2", "L3", "R3", "Eb"], // Fa♯
  7: ["LT", "L1", "L2", "L3", "Eb"], // Sol
  8: ["LT", "L1", "L2", "L3", "Gis", "Eb"], // Sol♯
  9: ["LT", "L1", "L2", "Eb"], // La
  10: ["LT", "L1", "R1", "Eb"], // Si♭
  11: ["LT", "L1", "Eb"], // Si
};

/** Doigté pour une note MIDI, ou null hors des deux premières octaves. */
export function fingeringFor(midi: number): Key[] | null {
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  if (m >= 60 && m <= 71) return LOW[pc];
  if (m === 72) return ["L1", "Eb"]; // Do5
  if (m === 73) return ["Eb"]; // Do♯5
  if (m === 74) return ["LT", "L2", "L3", "R1", "R2", "R3"]; // Ré5 : index gauche levé
  if (m === 75) return ["LT", "L2", "L3", "R1", "R2", "R3", "Eb"]; // Mi♭5
  if (m >= 76 && m <= 83) return LOW[pc]; // Mi5 → Si5 : même doigté, en soufflant plus vite
  if (m === 84) return ["L1", "Eb"]; // Do6
  return null;
}
