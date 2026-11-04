import { useEffect, useState } from "react";
import { cancelImport, dismissImportResults, remainingTime } from "../lib/importJobs";
import { useImportStatus } from "./ImportButton";

/**
 * Pastille visible hors de la bibliothèque (lecteur, « Ma flûte ») : l'import continue pendant que
 * l'on joue ou que l'on écoute une autre partition. « Voir » ramène à la bibliothèque.
 */
export function ImportIndicator({ onShow }: { onShow: () => void }) {
  const status = useImportStatus();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status.kind !== "busy") return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status.kind]);
  if (status.kind === "idle") return null;

  if (status.kind === "done") {
    const ok = status.results.filter((r) => "entry" in r);
    const failed = status.results.length - ok.length;
    return (
      <div className={`import-pill done${failed ? " error" : ""}`} role="status">
        <span>
          {ok.length === 1 && "entry" in ok[0]
            ? `✅ « ${ok[0].entry.title} » ajoutée à la bibliothèque`
            : ok.length > 1
              ? `✅ ${ok.length} partitions ajoutées à la bibliothèque`
              : "⚠️ Import non abouti"}
          {ok.length > 0 && failed > 0 && ` · ⚠️ ${failed} échec${failed > 1 ? "s" : ""}`}
        </span>
        <button className="link" onClick={onShow}>
          Voir
        </button>
        <button className="link" onClick={dismissImportResults} aria-label="Masquer">
          ✕
        </button>
      </div>
    );
  }

  const left = remainingTime(status, now);
  return (
    <div className="import-pill" role="status" title={status.label}>
      <span className="import-pill-text">
        {status.pdf ? "📄" : "🎼"} Import de {status.file}
        {status.count > 1 && ` (${status.index}/${status.count})`} · <b>{status.percent} %</b>
        {left && <small> · {left}</small>}
      </span>
      <span className="import-pill-bar" aria-hidden>
        <span style={{ width: `${status.percent}%` }} />
      </span>
      <button className="link" onClick={onShow}>
        Voir
      </button>
      {status.pdf && status.percent < 90 && (
        <button className="link" onClick={cancelImport} disabled={status.cancelling}>
          {status.cancelling ? "Arrêt…" : "Annuler"}
        </button>
      )}
    </div>
  );
}
