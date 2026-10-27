/** Meilleur résultat par morceau, gardé sur l'appareil (fonctionne hors ligne). */
const KEY = "flute-progress-v1";

export interface PieceProgress {
  stars: number;
  plays: number;
}

export function loadProgress(): Record<string, PieceProgress> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, PieceProgress>;
  } catch {
    return {};
  }
}

export function recordResult(id: string, stars: number): Record<string, PieceProgress> {
  const all = loadProgress();
  const prev = all[id] ?? { stars: 0, plays: 0 };
  all[id] = { stars: Math.max(prev.stars, stars), plays: prev.plays + 1 };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Stockage indisponible (navigation privée) : on garde seulement en mémoire.
  }
  return all;
}
