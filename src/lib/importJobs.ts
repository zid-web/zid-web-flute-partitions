import type { CatalogEntry } from "./catalog";
import { prepareImport, readScoreBytes, readScoreFile } from "./import";
import { assembleOmrPages } from "./omrPages";
import { cancelPdf, convertPdf, isPdf } from "./pdfImport";
import { saveUserScore } from "./userScores";

/**
 * Imports en cours, indépendants des écrans : on peut ouvrir une partition, « Ma flûte », revenir
 * à la bibliothèque… pendant qu'un PDF est reconnu ; l'avancement est affiché partout
 * (barre dans la bibliothèque, pastille ailleurs). Les fichiers ajoutés pendant un import
 * attendent leur tour.
 */

/** Avancement de l'import en cours, affiché sous forme de barre avec pourcentage. */
export interface ImportProgress {
  file: string;
  /** Fichier en cours et nombre de fichiers (en attente compris). */
  index: number;
  count: number;
  percent: number;
  label: string;
  /** Heure de début (ms) du fichier en cours, pour estimer le temps restant d'un PDF. */
  startedAt: number;
  pdf: boolean;
  /** Partition d'orchestre : nombre de parties d'une page (reconnaissance longue). */
  orchestra?: number;
}

export type ImportResult = { file: string } & ({ entry: CatalogEntry; warnings: string[] } | { error: string });

export type ImportStatus =
  | { kind: "idle" }
  | ({ kind: "busy"; cancelling: boolean } & ImportProgress)
  | { kind: "done"; results: ImportResult[] };

let status: ImportStatus = { kind: "idle" };
const queue: File[] = [];
let results: ImportResult[] = [];
let done = 0;
let cancelled = false;
const listeners = new Set<() => void>();
const importedListeners = new Set<(entry: CatalogEntry) => void>();

function set(next: ImportStatus) {
  status = next;
  listeners.forEach((l) => l());
}

export function getImportStatus(): ImportStatus {
  return status;
}

/** Pour `useSyncExternalStore`. */
export function subscribeImport(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Chaque partition ajoutée à la bibliothèque, où que l'on soit dans l'application. */
export function onScoreImported(listener: (entry: CatalogEntry) => void): () => void {
  importedListeners.add(listener);
  return () => importedListeners.delete(listener);
}

export const isImporting = () => status.kind === "busy";

/** Temps restant estimé (« environ 2 min »), d'après le temps déjà passé et l'avancement. */
export function remainingTime(p: ImportProgress, now: number): string | null {
  const elapsed = (now - p.startedAt) / 1000;
  const f = (p.percent - 3) / 85; // partie lecture par Audiveris (3 % → 88 %)
  if (!p.pdf || f < 0.08 || f >= 1 || elapsed < 8) return null;
  const left = (elapsed * (1 - f)) / f;
  return left < 60 ? "moins d'une minute" : `environ ${Math.round(left / 60)} min`;
}

/** Arrête la conversion en cours ; les fichiers en attente ne sont pas importés. */
export function cancelImport(): void {
  if (status.kind !== "busy") return;
  cancelled = true;
  queue.length = 0;
  set({ ...status, cancelling: true });
  void cancelPdf();
}

/** Efface le bilan du dernier import. */
export function dismissImportResults(): void {
  if (status.kind === "done") set({ kind: "idle" });
}

/**
 * Ajoute à la bibliothèque une partition produite dans l'application (transcription d'un
 * enregistrement) : mêmes contrôles qu'un import, et la bibliothèque est prévenue.
 */
export async function addGeneratedScore(xml: string, name: string): Promise<ImportResult> {
  const { entry, xml: kept, accompaniment, warnings } = prepareImport(xml, name);
  const saved = await saveUserScore(entry, kept, accompaniment);
  importedListeners.forEach((l) => l(saved));
  return { file: name, entry: saved, warnings };
}

async function importXml(xml: string, name: string, extraWarnings: string[] = []) {
  const { entry, xml: kept, accompaniment, warnings } = prepareImport(xml, name);
  const saved = await saveUserScore(entry, kept, accompaniment);
  results.push({ file: name, entry: saved, warnings: [...warnings, ...extraWarnings] });
  importedListeners.forEach((l) => l(saved));
}

async function importOne(file: File) {
  const pdf = isPdf(file);
  const base: ImportProgress = { file: file.name, index: done + 1, count: done + 1 + queue.length, percent: 0, label: "", startedAt: Date.now(), pdf };
  let orchestra: number | undefined;
  const show = (percent: number, label: string) =>
    set({
      kind: "busy",
      cancelling: cancelled,
      ...base,
      count: done + 1 + queue.length,
      orchestra,
      percent: Math.round(Math.min(100, Math.max(0, percent))),
      label,
    });
  try {
    if (pdf) {
      // Reconnaissance par Audiveris (application pour ordinateur), page par page, puis les pages
      // sont rassemblées en morceaux.
      show(1, "Préparation du PDF…");
      const conversion = await convertPdf(file, (p) => {
        orchestra = p.orchestra;
        show(3 + 85 * p.fraction, p.label);
      });
      show(90, "Écriture de la partition (MusicXML)…");
      const pages = await Promise.all(conversion.pages.map(async (f) => ({ name: f.name, xml: await readScoreBytes(f.bytes) })));
      const pieces = assembleOmrPages(pages);
      const n = conversion.failed.length;
      const skipped =
        n === 0
          ? []
          : [
              `page${n > 1 ? "s" : ""} ${conversion.failed.join(", ")} sur ${conversion.pageCount} non reconnue${n > 1 ? "s" : ""} (sautée${n > 1 ? "s" : ""}) : vérifiez la partition, ou corrigez avec ✏️ Corriger des notes`,
            ];
      const stem = file.name.replace(/\.pdf$/i, "");
      for (const [k, piece] of pieces.entries()) {
        show(92 + (6 * k) / pieces.length, pieces.length > 1 ? `Rangement dans la bibliothèque (morceau ${k + 1} sur ${pieces.length})…` : "Rangement dans la bibliothèque…");
        // « Ballade.pdf » → « Ballade.mxl », « Ballade.mvt2.mxl »… (mouvements regroupés)
        await importXml(piece.xml, `${stem}${piece.suffix}.mxl`, k === 0 ? skipped : []);
      }
    } else {
      show(15, "Lecture du fichier…");
      const xml = await readScoreFile(file);
      show(55, "Analyse : parties, niveau, tempo…");
      await new Promise((r) => setTimeout(r, 0)); // laisse la barre s'afficher
      show(85, "Rangement dans la bibliothèque…");
      await importXml(xml, file.name);
    }
    show(100, "Ajoutée à la bibliothèque ✓");
    await new Promise((r) => setTimeout(r, queue.length ? 250 : 600));
  } catch (e) {
    results.push({ file: file.name, error: e instanceof Error ? e.message : String(e || "Import impossible.") });
  }
}

/**
 * Importe un ou plusieurs fichiers (par exemple tous les mouvements d'une sonate), dans l'ordre
 * choisi. Pendant un import, les nouveaux fichiers s'ajoutent à la file d'attente.
 */
export function startImport(files: File[]): void {
  if (!files.length) return;
  queue.push(...files);
  if (status.kind === "busy") {
    set({ ...status, count: done + 1 + queue.length });
    return;
  }
  results = [];
  done = 0;
  cancelled = false;
  void (async () => {
    while (queue.length && !cancelled) {
      const file = queue.shift()!;
      await importOne(file);
      done++;
    }
    queue.length = 0;
    set({ kind: "done", results });
  })();
}
