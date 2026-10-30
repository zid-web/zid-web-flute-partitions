import { Fragment, useMemo, useRef, useState } from "react";
import { LEVEL_LABELS, type CatalogEntry } from "../lib/catalog";
import type { PieceProgress } from "../lib/progress";
import { groupHeadings, loadSortKey, saveSortKey, SORT_LABELS, sortEntries, type SortKey } from "../lib/sortScores";
import { ImportButton } from "./ImportButton";

interface Props {
  catalog: CatalogEntry[];
  progress: Record<string, PieceProgress>;
  onOpen: (entry: CatalogEntry) => void;
  onImported: (entry: CatalogEntry) => void;
  onDelete: (entries: CatalogEntry[]) => void;
  /** Enregistre un fichier de sauvegarde des partitions importées. */
  onBackup: () => Promise<void>;
  /** Restaure un fichier de sauvegarde ; renvoie le message à afficher. */
  onRestore: (file: File) => Promise<string>;
  /** Ouvre « Ma flûte » (enregistrer le son de sa flûte). */
  onMyFlute: () => void;
}

const LEVELS = [1, 2, 3, 4, 5] as const;
const SORT_KEYS = Object.keys(SORT_LABELS) as SortKey[];
const dateFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });

export function Library({ catalog, progress, onOpen, onImported, onDelete, onBackup, onRestore, onMyFlute }: Props) {
  const restoreInput = useRef<HTMLInputElement>(null);
  const [backupMessage, setBackupMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [level, setLevel] = useState<CatalogEntry["level"] | 0>(0);
  const [mineOnly, setMineOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>(loadSortKey);
  // Mode « Supprimer plusieurs » : on coche des partitions importées au lieu de les ouvrir.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const mineCount = catalog.filter((e) => e.origin === "import").length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = catalog
      .filter((e) => !(mineOnly || selecting) || e.origin === "import")
      .filter((e) => level === 0 || e.level === level)
      .filter((e) => !q || `${e.title} ${e.composer}`.toLowerCase().includes(q));
    return sortEntries(filtered, sortKey);
  }, [catalog, level, mineOnly, selecting, query, sortKey]);
  const headings = useMemo(() => groupHeadings(shown, sortKey), [shown, sortKey]);

  const totalStars = Object.values(progress).reduce((s, p) => s + p.stars, 0);

  function changeSort(key: SortKey) {
    setSortKey(key);
    saveSortKey(key);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function stopSelecting() {
    setSelecting(false);
    setSelected(new Set());
  }

  function deleteSelected() {
    const entries = shown.filter((e) => selected.has(e.id));
    if (entries.length === 0) return;
    const what = entries.length === 1 ? `« ${entries[0].title} »` : `ces ${entries.length} partitions`;
    if (!window.confirm(`Supprimer ${what} de cet appareil ?`)) return;
    onDelete(entries);
    stopSelecting();
  }

  return (
    <main className="library">
      <header className="hero">
        <div>
          <h1>🎶 Flûte Partitions</h1>
          <p>Choisissez un morceau, jouez : chaque note s'allume quand vous la réussissez.</p>
        </div>
        <div className="hero-side">
          <div className="star-total" title="Étoiles gagnées">
            ⭐ {totalStars}
          </div>
          <button className="my-flute-button" onClick={onMyFlute} title="Enregistrer le son de votre flûte">
            🎙️ Ma flûte
          </button>
        </div>
      </header>

      <details className="help">
        <summary>❓ Comment ça marche ?</summary>
        <ol>
          <li>Choisissez un morceau (filtrez par niveau : ● Découverte → ●●●●● Avancé).</li>
          <li>
            <b>🔊 Écouter</b> : l'application joue le morceau, la partition défile. Réglez le tempo avec le curseur.
          </li>
          <li>
            <b>🎤 Jouer avec ma flûte</b> : autorisez le micro, puis jouez. La note attendue est en orange avec son
            doigté ; elle passe au vert quand elle est juste, une fausse note clignote en rouge.
          </li>
          <li>Débutant ? Cochez « Octave libre » : une note jouée à l'octave est acceptée.</li>
          <li>
            <b>📥 Importer une partition</b> : un fichier MusicXML (.mxl, .musicxml) téléchargé sur IMSLP ou ailleurs.
            Il reste sur cet appareil et fonctionne hors ligne.
          </li>
          <li>
            <b>Ranger</b> : « Trier par » classe les morceaux par niveau, date d'import, compositeur ou titre.
            <b> 🗑 Supprimer…</b> permet d'effacer plusieurs partitions importées d'un coup.
          </li>
          <li>
            <b>🎙️ Ma flûte</b> : enregistrez quelques notes de votre flûte ; « Écouter » jouera ensuite les partitions
            avec votre son.
          </li>
          <li>
            <b>💾 Sauvegarder</b> enregistre une copie de vos partitions importées ; <b>♻️ Restaurer</b> les remet
            dans l'application (après une réinstallation, ou sur un autre appareil).
          </li>
        </ol>
      </details>

      <div className="filters">
        <button className={level === 0 ? "chip active" : "chip"} onClick={() => setLevel(0)}>
          Tous
        </button>
        {LEVELS.map((l) => (
          <button key={l} className={level === l ? `chip active lvl${l}` : `chip lvl${l}`} onClick={() => setLevel(l)}>
            {"●".repeat(l)} {LEVEL_LABELS[l]}
          </button>
        ))}
        {mineCount > 0 && (
          <button className={mineOnly ? "chip active" : "chip"} onClick={() => setMineOnly((m) => !m)}>
            📥 Mes partitions ({mineCount})
          </button>
        )}
        <input
          className="search"
          type="search"
          placeholder="Titre ou compositeur…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="arrange">
        <label className="sort">
          Trier par
          <select value={sortKey} onChange={(e) => changeSort(e.target.value as SortKey)}>
            {SORT_KEYS.map((k) => (
              <option key={k} value={k}>
                {SORT_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        {!selecting && (
          <div className="backup">
            {mineCount > 0 && (
              <button
                className="ghost"
                title="Enregistrer une copie de vos partitions importées (à garder en lieu sûr)"
                onClick={() => {
                  setBackupMessage(null);
                  onBackup().catch(() => setBackupMessage({ text: "Sauvegarde impossible.", error: true }));
                }}
              >
                💾 Sauvegarder
              </button>
            )}
            <button className="ghost" title="Récupérer des partitions depuis un fichier de sauvegarde" onClick={() => restoreInput.current?.click()}>
              ♻️ Restaurer
            </button>
            <input
              ref={restoreInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                onRestore(file).then(
                  (text) => setBackupMessage({ text }),
                  (err: Error) => setBackupMessage({ text: err.message, error: true }),
                );
              }}
            />
          </div>
        )}
        {mineCount > 0 &&
          (selecting ? (
            <div className="select-bar" role="toolbar" aria-label="Suppression de partitions importées">
              <button
                className="chip"
                onClick={() =>
                  setSelected(selected.size === shown.length ? new Set() : new Set(shown.map((e) => e.id)))
                }
              >
                {selected.size === shown.length && shown.length > 0 ? "Tout désélectionner" : "Tout sélectionner"}
              </button>
              <button className="danger" disabled={selected.size === 0} onClick={deleteSelected}>
                🗑 Supprimer ({selected.size})
              </button>
              <button className="ghost" onClick={stopSelecting}>
                Annuler
              </button>
            </div>
          ) : (
            <button className="ghost" onClick={() => setSelecting(true)}>
              🗑 Supprimer…
            </button>
          ))}
      </div>
      {backupMessage && (
        <p className={backupMessage.error ? "select-hint error" : "select-hint"} role="status">
          {backupMessage.text}
        </p>
      )}
      {selecting && <p className="select-hint">Touchez les partitions importées à supprimer.</p>}

      {!selecting && (
        <ImportButton
          onImported={(entry) => {
            setMineOnly(false);
            setLevel(0);
            onImported(entry);
          }}
        />
      )}

      <ul className="cards">
        {shown.map((e, i) => {
          const stars = progress[e.id]?.stars ?? 0;
          const checked = selected.has(e.id);
          return (
            <Fragment key={e.id}>
              {headings[i] && <li className="group-heading">{headings[i]}</li>}
              <li className="card-slot">
                <button
                  className={`card lvl${e.level}${selecting ? " selectable" : ""}${checked ? " selected" : ""}`}
                  onClick={() => (selecting ? toggle(e.id) : onOpen(e))}
                  aria-pressed={selecting ? checked : undefined}
                >
                  {selecting && (
                    <span className="check" aria-hidden>
                      {checked ? "☑" : "☐"}
                    </span>
                  )}
                  <span className="level-badge">
                    Niveau {e.level} · {LEVEL_LABELS[e.level]}
                    {e.origin === "import" && <span className="mine-badge">importée</span>}
                    {e.origin === "omr" && (
                      <span className="mine-badge" title="Reconnue automatiquement à partir d'un PDF scanné">
                        🔍 reconnue
                      </span>
                    )}
                  </span>
                  <strong className="title">{e.title}</strong>
                  <span className="composer">{e.composer}</span>
                  <span className="meta">
                    {e.key && <>🎼 {e.key} </>}
                    {e.time && <>· {e.time} </>}
                    {e.range && (
                      <>
                        · {e.range.low}–{e.range.high}
                      </>
                    )}
                  </span>
                  {e.addedAt !== undefined && (
                    <span className="added">Importée le {dateFormat.format(e.addedAt)}</span>
                  )}
                  <span className="complexity" aria-label={`Complexité ${e.complexity} sur 100`}>
                    <span style={{ width: `${e.complexity}%` }} />
                  </span>
                  <span className="stars">{[1, 2, 3].map((n) => (n <= stars ? "★" : "☆")).join("")}</span>
                </button>
                {e.origin === "import" && !selecting && (
                  <button
                    className="delete"
                    aria-label={`Supprimer ${e.title}`}
                    title="Supprimer de cet appareil"
                    onClick={() => {
                      if (window.confirm(`Supprimer « ${e.title} » de cet appareil ?`)) onDelete([e]);
                    }}
                  >
                    ✕
                  </button>
                )}
              </li>
            </Fragment>
          );
        })}
        {shown.length === 0 && <li className="message">Aucun morceau pour ce filtre.</li>}
      </ul>
      <footer className="credits">
        Partitions du domaine public (IMSLP et répertoire traditionnel). Fonctionne hors ligne. Les partitions
        importées restent sur cet appareil. Version {__APP_VERSION__}, mise à jour automatique.
      </footer>
    </main>
  );
}
