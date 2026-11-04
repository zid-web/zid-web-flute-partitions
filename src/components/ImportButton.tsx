import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LEVEL_LABELS } from "../lib/catalog";
import { ACCEPTED_EXTENSIONS } from "../lib/import";
import {
  cancelImport,
  dismissImportResults,
  getImportStatus,
  remainingTime as remaining,
  startImport,
  subscribeImport,
} from "../lib/importJobs";
import { audiverisPath } from "../lib/pdfImport";

/** L'import en cours (ou son bilan), partagé par tous les écrans. */
export function useImportStatus() {
  return useSyncExternalStore(subscribeImport, getImportStatus);
}

/**
 * Import d'une partition MusicXML (.mxl / .musicxml / .xml) ou PDF téléchargée par l'utilisateur,
 * par exemple sur IMSLP. Tout se passe sur l'appareil : analyse, niveau, enregistrement. L'import
 * continue si l'on quitte la bibliothèque (`importJobs.ts`).
 */
export function ImportButton() {
  const inputRef = useRef<HTMLInputElement>(null);
  const status = useImportStatus();
  const [dragging, setDragging] = useState(false);
  const [help, setHelp] = useState(false);
  // Application pour ordinateur avec Audiveris : les PDF sont reconnus sur place.
  const [audiveris, setAudiveris] = useState<string | null>(null);
  useEffect(() => void audiverisPath().then(setAudiveris), []);
  // horloge pour le temps restant (rafraîchie chaque seconde pendant un import)
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status.kind !== "busy") return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status.kind]);
  const importFiles = startImport;
  const cancelling = status.kind === "busy" && status.cancelling;

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
        importFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="import-row">
        <button
          className="primary"
          onClick={() => inputRef.current?.click()}
          title={status.kind === "busy" ? "Les fichiers choisis attendront la fin de l'import en cours" : undefined}
        >
          {status.kind === "busy" ? "📥 Importer aussi…" : "📥 Importer une partition"}
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
            importFiles(files);
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
              onClick={cancelImport}
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
      {status.kind === "done" && (
        <button className="link import-dismiss" onClick={dismissImportResults}>
          Masquer
        </button>
      )}
      {status.kind === "busy" && (
        <p className="import-hint">Vous pouvez ouvrir d'autres partitions pendant l'import : il continue en arrière-plan.</p>
      )}
    </section>
  );
}
