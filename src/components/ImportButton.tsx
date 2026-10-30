import { useRef, useState } from "react";
import { LEVEL_LABELS, type CatalogEntry } from "../lib/catalog";
import { ACCEPTED_EXTENSIONS, prepareImport, readScoreFile } from "../lib/import";
import { saveUserScore } from "../lib/userScores";

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; entry: CatalogEntry; warnings: string[] }
  | { kind: "error"; message: string };

/**
 * Import d'une partition MusicXML (.mxl / .musicxml / .xml) téléchargée par l'utilisateur,
 * par exemple sur IMSLP. Tout se passe sur l'appareil : analyse, niveau, enregistrement.
 */
export function ImportButton({ onImported }: { onImported: (entry: CatalogEntry) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [help, setHelp] = useState(false);

  async function importFile(file: File) {
    setStatus({ kind: "busy" });
    try {
      const { entry, xml, accompaniment, warnings } = prepareImport(await readScoreFile(file), file.name);
      const saved = await saveUserScore(entry, xml, accompaniment);
      setStatus({ kind: "done", entry, warnings });
      onImported(saved);
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Import impossible." });
    }
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
        const file = e.dataTransfer.files[0];
        if (file) void importFile(file);
      }}
    >
      <div className="import-row">
        <button className="primary" onClick={() => inputRef.current?.click()} disabled={status.kind === "busy"}>
          📥 Importer une partition
        </button>
        <span className="import-hint">
          Fichier MusicXML (.mxl, .musicxml) — ou glissez-le ici.{" "}
          <button className="link" onClick={() => setHelp((h) => !h)}>
            Où en trouver ?
          </button>
        </span>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXTENSIONS}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void importFile(file);
          }}
        />
      </div>

      {help && (
        <ol className="import-help">
          <li>
            Sur <b>imslp.org</b>, ouvrez une œuvre pour flûte et cherchez un fichier marqué <b>MusicXML</b> ou <b>.mxl</b>{" "}
            (souvent dans l'onglet « Arrangements and Transcriptions » ou les éditions « typeset »).
          </li>
          <li>Téléchargez-le, puis importez-le ici. Un PDF seul ne suffit pas : les notes ne pourraient pas s'allumer.</li>
          <li>
            Un PDF peut être converti en MusicXML avec MuseScore (import PDF) ou Audiveris, puis relu avant import.
          </li>
          <li>Si la partition contient plusieurs instruments, seule la partie de flûte est gardée.</li>
        </ol>
      )}

      {status.kind === "busy" && <p className="import-status">Analyse de la partition…</p>}
      {status.kind === "error" && <p className="import-status error">⚠️ {status.message}</p>}
      {status.kind === "done" && (
        <p className="import-status ok">
          ✅ « {status.entry.title} » ajoutée — niveau {status.entry.level} ({LEVEL_LABELS[status.entry.level]}),
          complexité {status.entry.complexity}/100.
          {status.warnings.map((w) => (
            <span key={w} className="warning">
              {" "}
              ⚠️ {w}.
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
