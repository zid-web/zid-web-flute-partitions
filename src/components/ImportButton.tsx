import { useEffect, useRef, useState } from "react";
import { LEVEL_LABELS, type CatalogEntry } from "../lib/catalog";
import { ACCEPTED_EXTENSIONS, prepareImport, readScoreBytes, readScoreFile } from "../lib/import";
import { audiverisPath, convertPdf, isPdf } from "../lib/pdfImport";
import { saveUserScore } from "../lib/userScores";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; text?: string }
  | { kind: "done"; results: Result[] };

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

  async function importXml(xml: string, name: string, results: Result[]) {
    const { entry, xml: kept, accompaniment, warnings } = prepareImport(xml, name);
    const saved = await saveUserScore(entry, kept, accompaniment);
    results.push({ file: name, entry: saved, warnings });
    onImported(saved);
  }

  /** Un ou plusieurs fichiers (par exemple tous les mouvements d'une sonate), importés dans l'ordre choisi. */
  async function importFiles(files: File[]) {
    if (!files.length) return;
    setStatus({ kind: "busy" });
    const results: Result[] = [];
    for (const file of files) {
      try {
        if (isPdf(file)) {
          // Reconnaissance par Audiveris (application pour ordinateur), puis import de chaque morceau.
          setStatus({ kind: "busy", text: `Lecture de « ${file.name} » par Audiveris… (1 à 2 minutes par page)` });
          for (const part of await convertPdf(file)) {
            const base = file.name.replace(/\.pdf$/i, "");
            // « Ballade.mvt2.mxl » → « Ballade.mvt2.mxl » ; garde le nom d'origine du PDF
            await importXml(await readScoreBytes(part.bytes), `${base}${part.name.slice(part.name.indexOf("."))}`, results);
          }
          continue;
        }
        await importXml(await readScoreFile(file), file.name, results);
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
              ? "Un PDF est lu directement par Audiveris, installé sur cet ordinateur (1 à 2 minutes par page). La reconnaissance n'est jamais parfaite : relisez la partition."
              : "Un PDF se lit dans l'application pour ordinateur (Mac, Windows) avec Audiveris installé. Sinon, convertissez-le en MusicXML avec MuseScore (Fichier › Importer) ou Audiveris, puis importez le .mxl."}
          </li>
          <li>Si la partition contient plusieurs instruments, seule la partie de flûte est gardée.</li>
          <li>
            Une œuvre en plusieurs mouvements : importez les fichiers ensemble (un par mouvement) ; à l'écoute, ils
            s'enchaînent tout seuls.
          </li>
        </ol>
      )}

      {status.kind === "busy" && <p className="import-status">{status.text ?? "Analyse de la partition…"}</p>}
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
