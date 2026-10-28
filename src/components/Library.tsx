import { useMemo, useState } from "react";
import { LEVEL_LABELS, type CatalogEntry } from "../lib/catalog";
import type { PieceProgress } from "../lib/progress";
import { ImportButton } from "./ImportButton";

interface Props {
  catalog: CatalogEntry[];
  progress: Record<string, PieceProgress>;
  onOpen: (entry: CatalogEntry) => void;
  onImported: (entry: CatalogEntry) => void;
  onDelete: (entry: CatalogEntry) => void;
}

const LEVELS = [1, 2, 3, 4, 5] as const;

export function Library({ catalog, progress, onOpen, onImported, onDelete }: Props) {
  const [level, setLevel] = useState<CatalogEntry["level"] | 0>(0);
  const [mineOnly, setMineOnly] = useState(false);
  const [query, setQuery] = useState("");
  const mineCount = catalog.filter((e) => e.origin === "import").length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog
      .filter((e) => !mineOnly || e.origin === "import")
      .filter((e) => level === 0 || e.level === level)
      .filter((e) => !q || `${e.title} ${e.composer}`.toLowerCase().includes(q))
      .sort((a, b) => a.level - b.level || a.complexity - b.complexity);
  }, [catalog, level, mineOnly, query]);

  const totalStars = Object.values(progress).reduce((s, p) => s + p.stars, 0);

  return (
    <main className="library">
      <header className="hero">
        <div>
          <h1>🎶 Flûte Partitions</h1>
          <p>Choisissez un morceau, jouez : chaque note s'allume quand vous la réussissez.</p>
        </div>
        <div className="star-total" title="Étoiles gagnées">
          ⭐ {totalStars}
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

      <ImportButton
        onImported={(entry) => {
          setMineOnly(false);
          setLevel(0);
          onImported(entry);
        }}
      />

      <ul className="cards">
        {shown.map((e) => {
          const stars = progress[e.id]?.stars ?? 0;
          return (
            <li key={e.id} className="card-slot">
              <button className={`card lvl${e.level}`} onClick={() => onOpen(e)}>
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
                <span className="complexity" aria-label={`Complexité ${e.complexity} sur 100`}>
                  <span style={{ width: `${e.complexity}%` }} />
                </span>
                <span className="stars">{[1, 2, 3].map((i) => (i <= stars ? "★" : "☆")).join("")}</span>
              </button>
              {e.origin === "import" && (
                <button
                  className="delete"
                  aria-label={`Supprimer ${e.title}`}
                  title="Supprimer de cet appareil"
                  onClick={() => {
                    if (window.confirm(`Supprimer « ${e.title} » de cet appareil ?`)) onDelete(e);
                  }}
                >
                  ✕
                </button>
              )}
            </li>
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
