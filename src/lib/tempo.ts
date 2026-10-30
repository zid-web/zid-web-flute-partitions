/**
 * Tempo d'une partition MusicXML, lu comme MuseScore :
 * - `<sound tempo="…">` en priorité (toujours en noires par minute) ;
 * - sinon l'indication métronomique (♩. = 60 en 6/8 → 90 noires par minute) ;
 * - sans indication : 120, la valeur par défaut de MuseScore.
 * Les changements de tempo en cours de morceau sont pris en compte, mesure par mesure.
 */
export const DEFAULT_QPM = 120;

const BEAT_UNIT_QUARTERS: Record<string, number> = {
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
  "32nd": 0.125,
};

const child = (el: Element, name: string) => Array.from(el.children).find((c) => c.localName === name);

/** Noires par minute d'une indication `<metronome>` (null si illisible, ex. « ♩ = ♪ »). */
function metronomeQpm(metronome: Element): number | null {
  const perMinute = Number(child(metronome, "per-minute")?.textContent?.match(/\d+(\.\d+)?/)?.[0]);
  const unit = BEAT_UNIT_QUARTERS[child(metronome, "beat-unit")?.textContent?.trim() ?? ""];
  if (!perMinute || !unit) return null;
  const dotted = Array.from(metronome.children).filter((c) => c.localName === "beat-unit-dot").length;
  return perMinute * unit * (2 - 1 / 2 ** dotted);
}

/** Tempo (noires par minute) au début de chaque mesure de la première partie. */
export function tempoMap(xml: string): number[] {
  const part = new DOMParser().parseFromString(xml, "application/xml").getElementsByTagName("part")[0];
  return part ? partTempoMap(part) : [];
}

const measuresOf = (part: Element) => Array.from(part.children).filter((c) => c.localName === "measure");

/** Une partie porte-t-elle elle-même une indication de tempo ? */
export function hasTempoMarks(part: Element): boolean {
  return (
    Array.from(part.getElementsByTagName("sound")).some((s) => s.hasAttribute("tempo")) ||
    part.getElementsByTagName("metronome").length > 0
  );
}

/**
 * MuseScore n'écrit le tempo que dans la première partie : quand on ne garde que la flûte
 * (une autre partie), on y recopie les changements de tempo pour ne pas les perdre.
 */
export function copyTempoMarks(map: number[], part: Element): void {
  const measures = measuresOf(part);
  map.forEach((qpm, i) => {
    const measure = measures[i];
    if (!measure || (i > 0 && map[i - 1] === qpm) || (i === 0 && qpm === DEFAULT_QPM)) return;
    const sound = part.ownerDocument.createElementNS(measure.namespaceURI, "sound");
    sound.setAttribute("tempo", String(qpm));
    measure.insertBefore(sound, measure.firstChild);
  });
}

export function partTempoMap(part: Element): number[] {
  const map: number[] = [];
  let current = DEFAULT_QPM;
  for (const measure of measuresOf(part)) {
    let fromSound: number | null = null;
    let fromMetronome: number | null = null;
    for (const sound of Array.from(measure.getElementsByTagName("sound"))) {
      const v = Number(sound.getAttribute("tempo"));
      if (v > 0 && fromSound === null) fromSound = v;
    }
    for (const metronome of Array.from(measure.getElementsByTagName("metronome"))) {
      fromMetronome ??= metronomeQpm(metronome);
    }
    current = fromSound ?? fromMetronome ?? current;
    map.push(current);
  }
  return map;
}
