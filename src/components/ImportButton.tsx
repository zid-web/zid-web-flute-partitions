import { useEffect, useRef, useState } from "react";
import { LEVEL_LABELS, type CatalogEntry } from "../lib/catalog";
import { ACCEPTED_EXTENSIONS, prepareImport, readScoreBytes, readScoreFile } from "../lib/import";
import { assembleOmrPages } from "../lib/omrPages";
import { audiverisPath, cancelPdf, convertPdf, isPdf } from "../lib/pdfImport";
import { saveUserScore } from "../lib/userScores";

type Status =
  | { kind: "idle" }
  | ({ kind: "busy" } & Progress)
  | { kind: "done"; results: Result[] };

/** Avancement de l'import en cours, affiché sous forme de barre avec pourcentage. */
interface Progress {
  file: string;
  /** Fichier en cours et nombre de fichiers choisis. */
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

/** Temps restant estimé (« environ 2 min »), d'après le temps déjà passé et l'avancement. */
function remaining(p: Progress, now: number): string | null {
  const elapsed = (now - p.startedAt) / 1000;
  const f = (p.percent - 3) / 85; // partie lecture par Audiveris (3 % → 88 %)
  if (!p.pdf || f < 0.08 || f >= 1 || elapsed < 8) return null;
  const left = (elapsed * (1 - f)) / f;
  return left < 60 ? "moins d'une minute" : `environ ${Math.round(left / 60)} min`;
}

type Result = { file: string } & ({ entry: CatalogEntry; warnings: string[] } | { error: string });

/**
 * Import d'une partition MusicXML (.mxl / .musicxml / .xml) téléchargée par l'utilisateur,
 * par exemple sur IMSLP. Tout se passe sur l'appareil : analyse, niveau, enregistrement.
 */
export function ImportButton({ onImported }: { onImported: (entry: CatalogEntry) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [help, setHelp] = useState(false);
  // Application pour ordinateur avec Audiveris : les PDF sont reconnus sur place.
  const [audiveris, setAudiveris] = useState<string | null>(null);
  useEffect(() => void audiverisPath().then(setAudiveris), []);
  // « Annuler » : la conversion en cours s'arrête, les fichiers suivants ne sont pas importés.
  const cancelledRef = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  // horloge pour le temps restant (rafraîchie chaque seconde pendant un import)
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status.kind !== "busy") return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status.kind]);

  async function importXml(xml: string, name: string, results: Result[], extraWarnings: string[] = []) {
    const { entry, xml: kept, accompaniment, warnings } = prepareImport(xml, name);
    const saved = await saveUserScore(entry, kept, accompaniment);
    results.push({ file: name, entry: saved, warnings: [...warnings, ...extraWarnings] });
    onImported(saved);
  }

  /** Un ou plusieurs fichiers (par exemple tous les mouvements d'une sonate), importés dans l'ordre choisi. */
  async function importFiles(files: File[]) {
    if (!files.length) return;
    const results: Result[] = [];
    cancelledRef.current = false;
    setCancelling(false);
    for (const [i, file] of files.entries()) {
      if (cancelledRef.current) break;
      const pdf = isPdf(file);
      const base: Progress = { file: file.name, index: i + 1, count: files.length, percent: 0, label: "", startedAt: Date.now(), pdf };
      let orchestra: number | undefined;
      const show = (percent: number, label: string) =>
        setStatus({ kind: "busy", ...base, orchestra, percent: Math.round(Math.min(100, Math.max(0, percent))), label });
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
          const skipped =
            conversion.failed.length === 0
              ? []
              : [
                  `page${conversion.failed.length > 1 ? "s" : ""} ${conversion.failed.join(", ")} sur ${conversion.pageCount} non reconnue${conversion.failed.length > 1 ? "s" : ""} (sautée${conversion.failed.length > 1 ? "s" : ""}) : vérifiez la partition, ou corrigez avec ✏️ Corriger des notes`,
                ];
          const stem = file.name.replace(/\.pdf$/i, "");
          for (const [k, piece] of pieces.entries()) {
            show(92 + (6 * k) / pieces.length, pieces.length > 1 ? `Rangement dans la bibliothèque (morceau ${k + 1} sur ${pieces.length})…` : "Rangement dans la bibliothèque…");
            // « Ballade.pdf » → « Ballade.mxl », « Ballade.mvt2.mxl »… (mouvements regroupés)
            await importXml(piece.xml, `${stem}${piece.suffix}.mxl`, results, k === 0 ? skipped : []);
          }
        } else {
          show(15, "Lecture du fichier…");
          const xml = await readScoreFile(file);
          show(55, "Analyse : parties, niveau, tempo…");
          await new Promise((r) => setTimeout(r, 0)); // laisse la barre s'afficher
          show(85, "Rangement dans la bibliothèque…");
          await importXml(xml, file.name, results);
        }
        show(100, "Ajoutée à la bibliothèque ✓");
        await new Promise((r) => setTimeout(r, files.length > 1 ? 250 : 600));
      } catch (e) {
        results.push({ file: file.name, error: e instanceof Error ? e.message : "Import impossible." });
      }
    }
    setStatus({ kind: "done", results });
  }

  return (
    <section
      className={dragging ? "import dragging" : "import"}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void importFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="import-row">
        <button className="primary" onClick={() => inputRef.current?.click()} disabled={status.kind === "busy"}>
          📥 Importer une partition
        </button>
        <span className="import-hint">
          Fichier(s) MusicXML (.mxl, .musicxml){audiveris ? " ou PDF" : ""} — ou glissez-les ici.{" "}
          <button className="link" onClick={() => setHelp((h) => !h)}>
            Où en trouver ?
          </button>
        </span>
        <input
          ref={inputRef}
          type="file"
          accept={`${ACCEPTED_EXTENSIONS},.pdf`}
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void importFiles(files);
          }}
        />
      </div>

      {help && (
        <ol className="import-help">
          <li>
            Sur <b>imslp.org</b>, ouvrez une œuvre pour flûte et cherchez un fichier marqué <b>MusicXML</b> ou <b>.mxl</b>{" "}
            (souvent dans l'onglet « Arrangements and Transcriptions » ou les éditions « typeset »).
          </li>
          <li>Téléchargez-le, puis importez-le ici.</li>
          <li>
            {audiveris
              ? "Un PDF est lu directement par Audiveris, installé sur cet ordinateur (plusieurs pages à la fois, de 15 à 60 secondes par page). Pour une œuvre d'orchestre, importez la partie de flûte seule : c'est bien plus rapide. La reconnaissance n'est jamais parfaite : relisez la partition."
              : "Un PDF se lit dans l'application pour ordinateur (Mac, Windows) avec Audiveris installé. Sinon, convertissez-le en MusicXML avec MuseScore (Fichier › Importer) ou Audiveris, puis importez le .mxl."}
          </li>
          <li>Si la partition contient plusieurs instruments, seule la partie de flûte est gardée.</li>
          <li>
            Une œuvre en plusieurs mouvements : importez les fichiers ensemble (un par mouvement) ; à l'écoute, ils
            s'enchaînent tout seuls.
          </li>
        </ol>
      )}

      {status.kind === "busy" && (
        <div className="import-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={status.percent}>
          <div className="import-progress-head">
            <span className="import-progress-file">
              {status.pdf ? "📄" : "🎼"} {status.file}
              {status.count > 1 && <small> · fichier {status.index} sur {status.count}</small>}
            </span>
            <strong>{status.percent} %</strong>
          </div>
          <div className={`import-progress-bar${status.percent >= 100 ? " done" : ""}`}>
            <span style={{ width: `${status.percent}%` }} />
          </div>
          <div className="import-progress-label">
            {status.label}
            {remaining(status, now) && <small> — {remaining(status, now)} restantes</small>}
          </div>
          {status.pdf && status.orchestra && (
            <p className="import-progress-tip">
              🎻 Partition d'orchestre ({status.orchestra} parties par page) : la reconnaissance est longue et moins sûre. Pour
              aller beaucoup plus vite, annulez et importez la <b>partie de flûte seule</b> (sur IMSLP : onglet « Parts »,
              fichier « Flute »).
            </p>
          )}
          {status.pdf && status.percent < 90 && (
            <button
              className="ghost import-cancel"
              disabled={cancelling}
              onClick={() => {
                cancelledRef.current = true;
                setCancelling(true);
                void cancelPdf();
              }}
            >
              {cancelling ? "Arrêt…" : "✕ Annuler"}
            </button>
          )}
        </div>
      )}
      {status.kind === "done" &&
        status.results.map((r, i) =>
          "error" in r ? (
            <p key={i} className="import-status error">
              ⚠️ {status.results.length > 1 ? `${r.file} : ` : ""}
              {r.error}
            </p>
          ) : (
            <p key={i} className="import-status ok">
              ✅ « {r.entry.title} » ajoutée — niveau {r.entry.level} ({LEVEL_LABELS[r.entry.level]}), complexité{" "}
              {r.entry.complexity}/100.
              {r.warnings.map((w) => (
                <span key={w} className="warning">
                  {" "}
                  ⚠️ {w}.
                </span>
              ))}
            </p>
          ),
        )}
    </section>
  );
}
