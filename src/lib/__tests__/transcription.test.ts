// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cleanNotes, estimateKey, trackBeats, tempoOf, transcribe, type HeardNote } from "../transcription";
import { prepareImport } from "../import";
import { melodyNotes } from "../accompaniment";

/** Mélodie jouée : (hauteur, durée en temps), au tempo donné, avec un peu d'imprécision humaine. */
function play(notes: [number, number][], bpm: number, jitter = 0.015): HeardNote[] {
  const beat = 60 / bpm;
  let t = 0.4;
  let k = 0;
  return notes.map(([midi, beats]) => {
    const wobble = ((k++ * 7919) % 11) / 10 - 0.5; // pseudo-aléatoire, reproductible
    const n = { start: t + wobble * 2 * jitter, duration: beats * beat * 0.92, midi, amplitude: 0.7 };
    t += beats * beat;
    return n;
  });
}

const scaleC: [number, number][] = [[72, 1], [74, 1], [76, 1], [77, 1], [79, 2], [77, 1], [76, 1], [74, 1], [72, 0.5], [74, 0.5], [76, 2], [72, 4]];

describe("transcription d'un enregistrement", () => {
  it("tempo retrouvé, mesures, rythmes : noires, croches, blanches, ronde", () => {
    const heard = play(scaleC, 90);
    const beats = trackBeats(heard);
    expect(Math.abs(tempoOf(beats) - 90)).toBeLessThanOrEqual(4);
    const t = transcribe(heard, { instrument: "flute", title: "Gamme", beats: 4, beatType: 4, grid: 1 });
    expect(t.measures).toBe(4); // 16 temps
    expect(t.fifths).toBe(0);
    const doc = new DOMParser().parseFromString(t.xml, "application/xml");
    expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    const types = Array.from(doc.querySelectorAll("note:not(:has(rest)) > type")).map((n) => n.textContent);
    expect(types).toEqual(["quarter", "quarter", "quarter", "quarter", "half", "quarter", "quarter", "quarter", "eighth", "eighth", "half", "whole"]);
  });

  it("la partition s'importe comme une partition de flûte et se joue (mêmes notes)", () => {
    const t = transcribe(play(scaleC, 100), { instrument: "flute", title: "Gamme", beats: 4, beatType: 4, grid: 1 });
    const { entry, xml } = prepareImport(t.xml, "Gamme.musicxml");
    expect(entry.kind ?? "flute").toBe("flute");
    expect(melodyNotes(xml)).toHaveLength(scaleC.length);
  });

  it("une note longue qui passe la barre de mesure est liée", () => {
    const t = transcribe(play([[72, 3], [74, 3], [76, 2]], 80), { instrument: "flute", title: "Liée", beats: 4, beatType: 4, grid: 1 });
    expect((t.xml.match(/<tie type="start"\/>/g) ?? []).length).toBe(1); // Ré : 1 temps + 2 temps
    expect(t.measures).toBe(2);
  });

  it("flûte : une seule note à la fois (harmonique fantôme et note trop grave écartées)", () => {
    const heard: HeardNote[] = [
      { start: 0, duration: 1, midi: 72, amplitude: 0.8 },
      { start: 0.01, duration: 0.9, midi: 84, amplitude: 0.3 }, // harmonique
      { start: 1, duration: 1, midi: 40, amplitude: 0.9 }, // impossible à la flûte
      { start: 1, duration: 1, midi: 74, amplitude: 0.8 },
    ];
    expect(cleanNotes(heard, "flute").map((n) => n.midi)).toEqual([72, 74]);
    expect(cleanNotes(heard, "piano").map((n) => n.midi).sort()).toEqual([40, 72, 74]); // l'harmonique aussi
    // une blanche coupée en deux par l'écoute (sans silence) : une seule note
    const cut: HeardNote[] = [
      { start: 2.93, duration: 0.98, midi: 83, amplitude: 0.87 },
      { start: 3.9, duration: 0.15, midi: 83, amplitude: 0.74 },
      { start: 4.11, duration: 1.14, midi: 81, amplitude: 0.85 },
    ];
    expect(cleanNotes(cut, "flute").map((n) => [n.midi, +n.duration.toFixed(2)])).toEqual([[83, 1.12], [81, 1.14]]);
    // trois Sol répétés, qui se touchent : trois notes
    const repeated: HeardNote[] = [0.51, 1.1, 1.72].map((start) => ({ start, duration: 0.6, midi: 79, amplitude: 0.85 }));
    expect(cleanNotes(repeated, "flute")).toHaveLength(3);
  });

  it("tonalité : Sol majeur (1 dièse), Fa majeur (1 bémol)", () => {
    const g = play([[67, 1], [69, 1], [71, 1], [72, 1], [74, 1], [76, 1], [78, 1], [79, 2], [74, 1], [71, 1], [67, 2]], 90);
    expect(estimateKey(g)).toEqual({ fifths: 1, mode: "major" });
    const f = play([[65, 1], [67, 1], [69, 1], [70, 1], [72, 1], [74, 1], [76, 1], [77, 2], [72, 1], [69, 1], [65, 2]], 90);
    expect(estimateKey(f).fifths).toBe(-1);
    const t = transcribe(f, { instrument: "flute", title: "Fa", beats: 4, beatType: 4, grid: 1 });
    expect(t.xml).toContain("<step>B</step><alter>-1</alter>"); // Si♭, pas La♯
  });

  it("piano : une harmonique plus faible, attaquée avec sa note, n'est pas une note", () => {
    const heard: HeardNote[] = [
      { start: 1, duration: 1, midi: 48, amplitude: 0.8 },
      { start: 1.01, duration: 0.8, midi: 60, amplitude: 0.4 }, // octave (harmonique)
      { start: 1.02, duration: 0.8, midi: 67, amplitude: 0.35 }, // douzième
      { start: 1, duration: 1, midi: 64, amplitude: 0.7 }, // vraie note de l'accord
      { start: 2, duration: 1, midi: 60, amplitude: 0.75 }, // vraie note, plus tard
    ];
    expect(cleanNotes(heard, "piano").map((n) => n.midi).sort()).toEqual([48, 60, 64]);
  });

  it("piano : deux portées, accords, main gauche en clé de fa", () => {
    const heard: HeardNote[] = [];
    for (let b = 0; b < 8; b++) {
      const t = 0.5 + b * 0.6;
      heard.push({ start: t, duration: 0.55, midi: [72, 74, 76, 77][b % 4], amplitude: 0.7 });
      if (b % 2 === 0) for (const m of [48, 52, 55]) heard.push({ start: t, duration: 1.15, midi: m, amplitude: 0.6 });
    }
    const t = transcribe(heard, { instrument: "piano", title: "Piano", beats: 4, beatType: 4, grid: 1 });
    expect(t.xml).toContain("<staves>2</staves>");
    expect(t.xml).toContain("<sign>F</sign>");
    expect((t.xml.match(/<chord\/>/g) ?? []).length).toBeGreaterThanOrEqual(8); // accords de 3 sons
    expect(prepareImport(t.xml, "Piano.musicxml").entry.kind).toBe("piano");
  });

  it("tempo imposé, mesure à 3 temps, violon transcrit pour la flûte", () => {
    const heard = play([[67, 1], [69, 1], [71, 1], [72, 3], [74, 1], [76, 2]], 120);
    const t = transcribe(heard, { instrument: "violin", title: "Valse", tempo: 120, beats: 3, beatType: 4, grid: 1 });
    expect(t.tempo).toBeGreaterThanOrEqual(115);
    expect(t.measures).toBe(3);
    expect(t.xml).toContain("Flûte (transcrit du violon)");
    expect(prepareImport(t.xml, "Valse.musicxml").entry.kind ?? "flute").toBe("flute");
  });

  it("flûte + piano : la mélodie de la flûte est extraite, l'accompagnement écarté", () => {
    const flute = play([[79, 1], [81, 1], [83, 1], [84, 1], [86, 2], [84, 2], [83, 1], [81, 1], [79, 2]], 90);
    const beat = 60 / 90;
    const acc: HeardNote[] = [];
    for (let b = 0; b < 12; b += 2) {
      // accords de la main droite (dans la tessiture de la flûte !) et basses
      for (const m of [64, 67, 72]) acc.push({ start: 0.4 + b * beat, duration: 2 * beat * 0.9, midi: m, amplitude: 0.55 });
      acc.push({ start: 0.4 + b * beat, duration: 2 * beat * 0.9, midi: 48, amplitude: 0.7 });
    }
    const line = cleanNotes([...flute, ...acc], "flute").map((n) => n.midi);
    expect(line).toEqual([79, 81, 83, 84, 86, 84, 83, 81, 79]);
    const t = transcribe([...flute, ...acc], { instrument: "flute", title: "Duo", beats: 4, beatType: 4, grid: 1 });
    expect(t.notes).toBe(9);
    expect(t.measures).toBe(3);
  });

  it("levée (anacrouse) : le premier temps est trouvé grâce à l'accompagnement", () => {
    // une noire de levée, puis 2 mesures ; basses fortes sur les premiers temps
    const flute = play([[72, 1], [77, 2], [81, 2], [79, 2], [77, 2]], 100);
    const beat = 60 / 100;
    const bass: HeardNote[] = [1, 5].map((b) => ({ start: 0.4 + b * beat, duration: 3.6 * beat, midi: 41, amplitude: 0.9 }));
    const t = transcribe([...flute, ...bass], { instrument: "flute", title: "Levée", beats: 4, beatType: 4, grid: 1 });
    expect(t.pickupBeats).toBe(1);
    expect(t.xml).toContain('<measure number="0" implicit="yes">');
    expect(t.measures).toBe(2);
  });

  it("triolets : un temps joué en trois est écrit en triolet", () => {
    const heard = play([[72, 1], [74, 1 / 3], [76, 1 / 3], [77, 1 / 3], [79, 1], [77, 1], [76, 4]], 80, 0.005);
    const t = transcribe(heard, { instrument: "flute", title: "Triolet", beats: 4, beatType: 4, grid: 1 });
    expect((t.xml.match(/<actual-notes>3<\/actual-notes>/g) ?? []).length).toBe(3);
    expect(t.xml).toContain('<tuplet type="start" bracket="yes"/>');
    expect(t.measures).toBe(2);
    const { xml } = prepareImport(t.xml, "Triolet.musicxml");
    expect(melodyNotes(xml)).toHaveLength(7);
  });

  it("aucune note : message clair", () => {
    expect(() => transcribe([], { instrument: "flute", title: "x", beats: 4, beatType: 4, grid: 1 })).toThrow(/Aucune note/);
  });
});

describe("notes répétées rapides", () => {
  it("creux de volume mesuré : coup de langue = deux notes, note tenue coupée = une seule", () => {
    const two = (dip: number): HeardNote[] => [
      { start: 2.927, duration: 0.975, midi: 83, amplitude: 0.87 },
      { start: 3.902, duration: 0.152, midi: 83, amplitude: 0.74, dip },
    ];
    expect(cleanNotes(two(0.95), "flute")).toHaveLength(1); // pas de creux : note tenue coupée
    expect(cleanNotes(two(0.2), "flute")).toHaveLength(2); // creux : coup de langue
  });

  it("pointée-double sur la même note : deux notes, pas une", () => {
    const heard: HeardNote[] = [
      { start: 0.522, duration: 0.453, midi: 79, amplitude: 0.84 },
      { start: 0.975, duration: 0.151, midi: 79, amplitude: 0.72 },
      { start: 1.115, duration: 0.604, midi: 81, amplitude: 0.77 },
    ];
    expect(cleanNotes(heard, "flute")).toHaveLength(3);
  });
});
