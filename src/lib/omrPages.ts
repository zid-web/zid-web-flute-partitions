/**
 * Pages d'un PDF reconnues séparément par Audiveris (plusieurs à la fois, plus rapide, et une page
 * illisible ne fait plus tout échouer) : on les rassemble en une seule partition (logique pure,
 * testée). Les parties sont reprises dans l'ordre (la remise en ordre système par système,
 * `adoptOmrFlute`, vient ensuite) ; une partie absente d'une page y reçoit des mesures vides.
 */

export interface OmrPageFile {
  /** « p003~Ballade.mvt2.mxl » : page du PDF, puis nom donné par Audiveris. */
  name: string;
  xml: string;
}

export interface OmrPiece {
  /** « » s'il n'y a qu'un morceau ; sinon « .mvt1 », « .mvt2 »… (rangés ensemble). */
  suffix: string;
  /** Pages du PDF qui composent le morceau. */
  pages: number[];
  xml: string;
}

const kids = (el: Element, name: string) => Array.from(el.children).filter((c) => c.localName === name);

function pageOf(name: string): { page: number; mvt: number } {
  return {
    page: Number(name.match(/^p(\d+)~/)?.[1] ?? 0),
    mvt: Number(name.match(/\.mvt(\d+)/i)?.[1] ?? 1),
  };
}

/** Met bout à bout les pages d'un même morceau (MusicXML partwise). */
export function mergeScorePages(xmls: string[]): string {
  if (xmls.length === 1) return xmls[0];
  const docs = xmls.map((x) => new DOMParser().parseFromString(x, "application/xml"));
  // la page qui a le plus de parties donne la liste des parties
  const partsOf = (d: Document) => kids(d.documentElement, "part");
  const richest = docs.reduce((a, b) => (partsOf(b).length > partsOf(a).length ? b : a));
  // parties de chaque page, relevées avant de vider la première (qui sert de base)
  const pagesParts = docs.map(partsOf);
  const out = docs[0];
  const root = out.documentElement;
  const partList = kids(root, "part-list")[0];
  if (partList && richest !== out) {
    const list = kids(richest.documentElement, "part-list")[0];
    if (list) root.replaceChild(out.importNode(list, true), partList);
  }
  for (const p of partsOf(out)) p.remove();
  const ids = kids(kids(root, "part-list")[0] ?? root, "score-part").map((sp) => sp.getAttribute("id") ?? "");
  const count = Math.max(ids.length, ...pagesParts.map((p) => p.length));
  const parts = Array.from({ length: count }, (_, i) => {
    const part = out.createElementNS(root.namespaceURI, "part");
    part.setAttribute("id", ids[i] || `P${i + 1}`);
    root.appendChild(part);
    return part;
  });

  let offset = 0;
  pagesParts.forEach((pageParts, page) => {
    const length = Math.max(0, ...pageParts.map((p) => kids(p, "measure").length));
    parts.forEach((target, i) => {
      const measures = pageParts[i] ? kids(pageParts[i], "measure") : [];
      for (let k = 0; k < length; k++) {
        const m = measures[k] ? (out.importNode(measures[k], true) as Element) : out.createElementNS(root.namespaceURI, "measure");
        m.setAttribute("number", String(offset + k + 1));
        if (k === 0 && page > 0) {
          // nouvelle page : nouveau système (la flûte est retrouvée système par système)
          let print = kids(m, "print")[0];
          if (!print) {
            print = out.createElementNS(root.namespaceURI, "print");
            m.insertBefore(print, m.firstChild);
          }
          print.setAttribute("new-page", "yes");
        }
        target.appendChild(m);
      }
    });
    offset += length;
  });
  return new XMLSerializer().serializeToString(out);
}

const isFinalBarline = (m: Element) =>
  kids(m, "barline").some(
    (b) =>
      (b.getAttribute("location") ?? "right") === "right" &&
      kids(b, "bar-style")[0]?.textContent?.trim() === "light-heavy" &&
      !kids(b, "repeat").some((r) => r.getAttribute("direction") === "backward"),
  );
const startsSystem = (m: Element) =>
  kids(m, "print").some((p) => p.getAttribute("new-system") === "yes" || p.getAttribute("new-page") === "yes");
const startsRepeat = (m: Element) =>
  kids(m, "barline").some((b) => kids(b, "repeat").some((r) => r.getAttribute("direction") === "forward"));

/**
 * Le premier système commence-t-il en retrait (début d'un morceau, comme le repère Audiveris
 * lui-même) ? Marge gauche du premier système nettement plus grande que celle des suivants.
 */
export function startsIndented(xml: string): boolean {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const part = kids(doc.documentElement, "part")[0];
  if (!part) return false;
  const margins: number[] = [];
  kids(part, "measure").forEach((m, i) => {
    const print = kids(m, "print")[0];
    if (!print || (i > 0 && !startsSystem(m))) return;
    const left = Number(print.getElementsByTagName("left-margin")[0]?.textContent);
    // marges aberrantes (mesurées depuis l'autre bord) écartées
    if (Number.isFinite(left) && left > 0 && left < 500) margins.push(i === 0 ? -left : left);
  });
  const first = margins[0] !== undefined && margins[0] < 0 ? -margins[0] : null;
  const others = margins.filter((v) => v > 0).sort((a, b) => a - b);
  if (first === null || others.length === 0) return false;
  return first - others[others.length >> 1] >= 10;
}

/** La partition se termine-t-elle par une barre finale (fin d'un morceau) ? */
export function endsWithFinalBarline(xml: string): boolean {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const part = kids(doc.documentElement, "part")[0];
  const last = part ? kids(part, "measure").at(-1) : undefined;
  return !!last && isFinalBarline(last);
}

/**
 * Coupe une page à chaque fin de morceau qu'Audiveris n'a pas séparée : une barre finale (fine
 * puis épaisse, sans reprise) en fin de système, le morceau suivant commençant au système suivant
 * (recueils : « Three Christmas Carols », duos…). Chaque morceau reçoit la clé, l'armure, la mesure
 * et les divisions en vigueur.
 */
export function splitAtFinalBarlines(xml: string): string[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const parts = kids(doc.documentElement, "part");
  if (!parts.length) return [xml];
  const first = kids(parts[0], "measure");
  const cuts: number[] = [];
  for (let i = 0; i + 1 < first.length; i++) {
    if (isFinalBarline(first[i]) && startsSystem(first[i + 1]) && !startsRepeat(first[i + 1])) cuts.push(i + 1);
  }
  if (!cuts.length) return [xml];
  const bounds = [0, ...cuts, Infinity];
  const out: string[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const copy = doc.cloneNode(true) as Document;
    for (const part of kids(copy.documentElement, "part")) {
      const measures = kids(part, "measure");
      // attributs en vigueur au début du morceau (portés par les mesures précédentes)
      const current = new Map<string, Element>();
      measures.forEach((m, i) => {
        if (i < bounds[k]) {
          for (const a of kids(m, "attributes")) for (const c of Array.from(a.children)) current.set(c.localName, c);
          m.remove();
        } else if (i >= bounds[k + 1]) m.remove();
      });
      const head = kids(part, "measure")[0];
      if (head && current.size) {
        let attrs = kids(head, "attributes")[0];
        if (!attrs) {
          attrs = copy.createElementNS(copy.documentElement.namespaceURI, "attributes");
          const after = kids(head, "print")[0];
          head.insertBefore(attrs, after ? after.nextSibling : head.firstChild);
        }
        const order = ["divisions", "key", "time", "staves", "clef"];
        for (const name of order.reverse()) {
          const el = current.get(name);
          if (el && !kids(attrs, name).length) attrs.insertBefore(el.cloneNode(true), attrs.firstChild);
        }
      }
      kids(part, "measure").forEach((m, i) => m.setAttribute("number", String(i + 1)));
    }
    out.push(new XMLSerializer().serializeToString(copy));
  }
  return out;
}

/**
 * Regroupe les pages en morceaux. Un nouveau morceau commence : quand Audiveris en a trouvé un au
 * milieu d'une page (plusieurs fichiers pour la page) ; après une barre finale en fin de système
 * (au milieu d'une page, ou en bas de la page précédente) ; quand le premier système d'une page
 * est en retrait. Sinon, une page continue le morceau.
 */
export function assembleOmrPages(files: OmrPageFile[]): OmrPiece[] {
  const sorted = files
    .map((f) => ({ ...f, ...pageOf(f.name) }))
    .sort((a, b) => a.page - b.page || a.mvt - b.mvt);
  const groups: { pages: number[]; xmls: string[] }[] = [];
  let lastPage = -1;
  let ended = false; // le dernier morceau lu s'est terminé par une barre finale
  for (const f of sorted) {
    const chunks = splitAtFinalBarlines(f.xml);
    chunks.forEach((xml, c) => {
      const continues = groups.length > 0 && c === 0 && f.page !== lastPage && !ended && !startsIndented(xml);
      if (continues) {
        const g = groups[groups.length - 1];
        g.pages.push(f.page);
        g.xmls.push(xml);
      } else groups.push({ pages: [f.page], xmls: [xml] });
      ended = endsWithFinalBarline(xml);
    });
    lastPage = f.page;
  }
  // plusieurs morceaux : tous numérotés (« .mvt1 », « .mvt2 »…), rangés ensemble dans la bibliothèque
  return groups.map((g, i) => ({ suffix: groups.length === 1 ? "" : `.mvt${i + 1}`, pages: g.pages, xml: mergeScorePages(g.xmls) }));
}
