const SOLFEGE = ["Do", "Do♯", "Ré", "Mi♭", "Mi", "Fa", "Fa♯", "Sol", "Sol♯", "La", "Si♭", "Si"];

/** Fréquence (Hz) → numéro MIDI fractionnaire (La 440 = 69). */
export function freqToMidi(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4);
}

export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/** Nom de note en solfège français, avec octave (Do4 = do central). */
export function midiToName(midi: number, withOctave = true): string {
  const m = Math.round(midi);
  const name = SOLFEGE[((m % 12) + 12) % 12];
  return withOctave ? `${name}${Math.floor(m / 12) - 1}` : name;
}

/** Écart en cents entre une hauteur mesurée et la note attendue. */
export function centsOff(measuredMidi: number, expectedMidi: number): number {
  return (measuredMidi - expectedMidi) * 100;
}

/** Tessiture de la flûte traversière en ut (Do4 → Do7). */
export const FLUTE_RANGE = { low: 60, high: 96 } as const;
