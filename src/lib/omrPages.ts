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
  /** « » pour le premier morceau, « .mvt2 », « .mvt3 »… pour les suivants (mouvements). */
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

/**
 * Regroupe les pages en morceaux : une page continue le morceau en cours ; si Audiveris a trouvé
 * un début de mouvement au milieu d'une page (plusieurs fichiers pour la page), un nouveau
 * morceau commence.
 */
export function assembleOmrPages(files: OmrPageFile[]): OmrPiece[] {
  const sorted = files
    .map((f) => ({ ...f, ...pageOf(f.name) }))
    .sort((a, b) => a.page - b.page || a.mvt - b.mvt);
  const groups: { pages: number[]; xmls: string[] }[] = [];
  let lastPage = -1;
  for (const f of sorted) {
    const samePage = f.page === lastPage;
    if (groups.length === 0 || samePage) groups.push({ pages: [f.page], xmls: [f.xml] });
    else {
      const g = groups[groups.length - 1];
      g.pages.push(f.page);
      g.xmls.push(f.xml);
    }
    lastPage = f.page;
  }
  return groups.map((g, i) => ({ suffix: i === 0 ? "" : `.mvt${i + 1}`, pages: g.pages, xml: mergeScorePages(g.xmls) }));
}
