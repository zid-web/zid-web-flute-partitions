import { measureTimeline } from "./accompaniment";

/**
 * Points d'orgue et changements de tempo écrits en toutes lettres (logique pure, testée) :
 * « rit. », « rall. », « ritenuto », « allargando » ralentissent, « accel. », « stringendo »
 * pressent, « a tempo » / « Tempo I » ramènent au tempo. Un point d'orgue tient la note
 * environ deux fois plus longtemps. Le mode Écouter joue ainsi la partition, au lieu d'un
 * métronome. Résultat : une fonction qui donne, pour un instant de la partition (secondes au
 * tempo écrit), l'instant où il est joué.
 */

export interface ExpressiveMarks {
  /** Notes sous un point d'orgue : début et durée (secondes au tempo écrit). */
  fermatas: { at: number; seconds: number }[];
  /** Ralentissements (factor > 1) ou accélérations (factor < 1) : de `from` à `to`. */
  tempoChanges: { from: number; to: number; factor: number }[];
}

/** Durée d'une note sous un point d'orgue : × FERMATA_HOLD. */
export const FERMATA_HOLD = 1.8;
/** Fin d'un ritardando : tempo à 70 % (chaque temps dure 1/0,7 fois plus). */
export const RIT_END = 1 / 0.7;
/** Fin d'un accelerando : tempo à 120 %. */
export const ACCEL_END = 1 / 1.2;
/** Sans « a tempo » écrit, un rit. dure au plus deux mesures. */
const DEFAULT_SPAN_MEASURES = 2;

const RIT = /\b(rit|ritard|ritardando|rall|rallent|rallentando|riten|ritenuto|allarg|allargando|slentando|calando|morendo)\b/i;
const ACCEL = /\b(accel|accelerando|string|stringendo|stretto|piu mosso|più mosso)\b/i;
const A_TEMPO = /\b(a tempo|tempo i|tempo primo|tempo 1)\b/i;

const children = (el: Element, name: string) => Array.from(el.children).filter((c) => c.localName === name);
const text = (el: Element, name: string) => children(el, name)[0]?.textContent?.trim();

/** Points d'orgue et indications de tempo de toutes les parties. */
export function readExpressiveMarks(xmlOrDoc: string | Document): ExpressiveMarks {
  const doc = typeof xmlOrDoc === "string" ? new DOMParser().parseFromString(xmlOrDoc, "application/xml") : xmlOrDoc;
  const timeline = measureTimeline(doc);
  const fermatas = new Map<number, number>();
  type Mark = { at: number; kind: "rit" | "accel" | "atempo"; measure: number };
  const marks: Mark[] = [];
  let pieceEnd = timeline.startSec.at(-1) ?? 0; // complété avec la longueur de la dernière mesure

  for (const part of children(doc.documentElement, "part")) {
    let divisions = 1;
    children(part, "measure").forEach((measure, m) => {
      const spq = timeline.secPerQuarter[m] ?? 0.5;
      const start = timeline.startSec[m] ?? 0;
      let pos = 0;
      let lastStart = 0;
      for (const el of Array.from(measure.children)) {
        if (el.localName === "attributes") divisions = Number(text(el, "divisions")) || divisions;
        else if (el.localName === "backup") pos -= Number(text(el, "duration") ?? 0) / divisions;
        else if (el.localName === "forward") pos += Number(text(el, "duration") ?? 0) / divisions;
        else if (el.localName === "direction") {
          const words = Array.from(el.getElementsByTagName("words"))
            .map((w) => w.textContent ?? "")
            .join(" ");
          const at = start + pos * spq;
          const newTempo = el.getElementsByTagName("metronome").length > 0 || !!el.querySelector("sound[tempo]");
          if (A_TEMPO.test(words) || newTempo) marks.push({ at, kind: "atempo", measure: m });
          else if (RIT.test(words)) marks.push({ at, kind: "rit", measure: m });
          else if (ACCEL.test(words)) marks.push({ at, kind: "accel", measure: m });
        } else if (el.localName === "note") {
          if (children(el, "grace").length || children(el, "cue").length) continue;
          const quarters = Number(text(el, "duration") ?? 0) / divisions;
          const isChord = children(el, "chord").length > 0;
          const noteStart = isChord ? lastStart : pos;
          if (!isChord) {
            lastStart = pos;
            pos += quarters;
          }
          if (el.getElementsByTagName("fermata").length) {
            const at = start + noteStart * spq;
            const key = Math.round(at * 1000) / 1000;
            fermatas.set(key, Math.max(fermatas.get(key) ?? 0, quarters * spq));
          }
        }
      }
      pieceEnd = Math.max(pieceEnd, start + pos * spq);
    });
  }

  marks.sort((a, b) => a.at - b.at);
  const tempoChanges: ExpressiveMarks["tempoChanges"] = [];
  marks.forEach((mark, i) => {
    if (mark.kind === "atempo") return;
    // jusqu'à l'indication suivante (a tempo, nouveau tempo, autre rit.), sinon deux mesures
    const next = marks.slice(i + 1).find((x) => x.at > mark.at + 1e-6);
    const limitMeasure = mark.measure + DEFAULT_SPAN_MEASURES;
    const limit = timeline.startSec[limitMeasure] ?? pieceEnd;
    const to = Math.min(next ? next.at : Infinity, limit, pieceEnd);
    if (to > mark.at) tempoChanges.push({ from: mark.at, to, factor: mark.kind === "rit" ? RIT_END : ACCEL_END });
  });
  return {
    fermatas: [...fermatas].map(([at, seconds]) => ({ at, seconds })).sort((a, b) => a.at - b.at),
    tempoChanges,
  };
}

/** Réunit les marques de la partition de l'élève et de l'accompagnement (sans doublons). */
export function mergeMarks(...all: ExpressiveMarks[]): ExpressiveMarks {
  const fermatas = new Map<number, number>();
  for (const m of all) for (const f of m.fermatas) fermatas.set(Math.round(f.at * 1000) / 1000, Math.max(fermatas.get(f.at) ?? 0, f.seconds));
  const seen = new Set<string>();
  const tempoChanges = all
    .flatMap((m) => m.tempoChanges)
    .filter((c) => {
      const key = `${c.from.toFixed(3)}-${c.factor}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.from - b.from);
  return { fermatas: [...fermatas].map(([at, seconds]) => ({ at, seconds })).sort((a, b) => a.at - b.at), tempoChanges };
}

/**
 * Temps joué (secondes) pour un instant de la partition (secondes au tempo écrit). Croissante ;
 * identique au temps écrit avant le premier point d'orgue ou ralenti.
 */
export function timeWarp(marks: ExpressiveMarks): (sec: number) => number {
  if (marks.fermatas.length === 0 && marks.tempoChanges.length === 0) return (s) => s;
  // Facteur d'étirement par morceaux : 1 hors des marques ; sous un point d'orgue FERMATA_HOLD ;
  // dans un rit./accel., il va progressivement de 1 au facteur final.
  const stretch = (t: number): number => {
    let f = 1;
    for (const fm of marks.fermatas) if (t >= fm.at && t < fm.at + fm.seconds) f *= FERMATA_HOLD;
    for (const c of marks.tempoChanges) {
      if (t >= c.from && t < c.to) f *= 1 + (c.factor - 1) * ((t - c.from) / (c.to - c.from));
    }
    return f;
  };
  // Points où le facteur change : intégration exacte par morceaux (trapèzes sur un pas fin).
  const edges = new Set<number>([0]);
  for (const fm of marks.fermatas) edges.add(fm.at).add(fm.at + fm.seconds);
  for (const c of marks.tempoChanges) edges.add(c.from).add(c.to);
  const points = [...edges].sort((a, b) => a - b);
  const STEP = 0.02;
  const table: { t: number; w: number }[] = [{ t: 0, w: 0 }];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const n = Math.max(1, Math.ceil((b - a) / STEP));
    for (let k = 1; k <= n; k++) {
      const t0 = a + ((k - 1) * (b - a)) / n;
      const t1 = a + (k * (b - a)) / n;
      const mid = (t0 + t1) / 2;
      table.push({ t: t1, w: table[table.length - 1].w + (t1 - t0) * stretch(mid) });
    }
  }
  const last = table[table.length - 1];
  return (sec: number) => {
    if (sec <= 0) return sec;
    if (sec >= last.t) return last.w + (sec - last.t);
    let lo = 0;
    let hi = table.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (table[mid].t <= sec) lo = mid;
      else hi = mid;
    }
    const a = table[lo];
    const b = table[hi];
    return a.w + ((sec - a.t) / (b.t - a.t || 1)) * (b.w - a.w);
  };
}
