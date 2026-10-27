import { useMemo, useState } from "react";
import { LEVEL_LABELS, type CatalogEntry } from "../lib/catalog";
import type { PieceProgress } from "../lib/progress";

interface Props {
  catalog: CatalogEntry[];
  progress: Record<string, PieceProgress>;
  onOpen: (entry: CatalogEntry) => void;
}

const LEVELS = [1, 2, 3, 4, 5] as const;

export function Library({ catalog, progress, onOpen }: Props) {
  const [level, setLevel] = useState<CatalogEntry["level"] | 0>(0);
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog
      .filter((e) => level === 0 || e.level === level)
      .filter((e) => !q || `${e.title} ${e.composer}`.toLowerCase().includes(q))
      .sort((a, b) => a.level - b.level || a.complexity - b.complexity);
  }, [catalog, level, query]);

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

      <div className="filters">
        <button className={level === 0 ? "chip active" : "chip"} onClick={() => setLevel(0)}>
          Tous
        </button>
        {LEVELS.map((l) => (
          <button key={l} className={level === l ? `chip active lvl${l}` : `chip lvl${l}`} onClick={() => setLevel(l)}>
            {"●".repeat(l)} {LEVEL_LABELS[l]}
          </button>
        ))}
        <input
          className="search"
          type="search"
          placeholder="Titre ou compositeur…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <ul className="cards">
        {shown.map((e) => {
          const stars = progress[e.id]?.stars ?? 0;
          return (
            <li key={e.id}>
              <button className={`card lvl${e.level}`} onClick={() => onOpen(e)}>
                <span className="level-badge">
                  Niveau {e.level} · {LEVEL_LABELS[e.level]}
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
            </li>
          );
        })}
        {shown.length === 0 && <li className="message">Aucun morceau pour ce filtre.</li>}
      </ul>
      <footer className="credits">
        Partitions du domaine public (IMSLP et répertoire traditionnel). Fonctionne hors ligne.
      </footer>
    </main>
  );
}
