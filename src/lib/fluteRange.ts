/**
 * Tessiture de la flûte : du Si3 (patte de si) au Ré7, en numéros MIDI — les mêmes bornes que
 * l'avertissement d'import (`scoreWarnings`). Une note plus grave ou plus aiguë ne peut pas être
 * jouée (ni reconnue au micro) : à l'import, on la ramène dans la tessiture, octave par octave.
 * Le plus souvent, c'est une erreur de reconnaissance (Audiveris) ou une partie écrite à l'octave.
 */
export const FLUTE_LOW = 59;
export const FLUTE_HIGH = 98;

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const kid = (el: Element, name: string) => Array.from(el.children).find((c) => c.localName === name) ?? null;

/** Octave à ajouter (+n) ou retirer (−n) pour qu'une note soit jouable à la flûte. */
export function octaveShift(midi: number): number {
  let shift = 0;
  while (midi + 12 * shift < FLUTE_LOW) shift++;
  while (midi + 12 * shift > FLUTE_HIGH) shift--;
  return shift;
}

/**
 * Ramène dans la tessiture de la flûte toutes les notes d'une partie (montées ou descendues
 * d'une ou plusieurs octaves). Renvoie le nombre de notes changées.
 */
export function foldToFluteRange(part: Element): number {
  let changed = 0;
  for (const note of Array.from(part.getElementsByTagName("note"))) {
    const pitch = kid(note, "pitch");
    const step = pitch && kid(pitch, "step")?.textContent?.trim();
    const octaveEl = pitch && kid(pitch, "octave");
    if (!pitch || !step || !(step in STEP) || !octaveEl) continue;
    const octave = Number(octaveEl.textContent);
    const alter = Math.round(Number(kid(pitch, "alter")?.textContent ?? 0));
    const shift = octaveShift((octave + 1) * 12 + STEP[step] + alter);
    if (shift === 0) continue;
    octaveEl.textContent = String(octave + shift);
    // une hampe ou une position verticale forcée n'aurait plus de sens à la nouvelle hauteur
    const stem = kid(note, "stem");
    if (stem && stem.textContent !== "none") stem.remove();
    note.removeAttribute("default-y");
    changed++;
  }
  return changed;
}
