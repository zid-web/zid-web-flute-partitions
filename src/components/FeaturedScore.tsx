import { useMemo } from "react";
import { partnersOf } from "../lib/accompaniment";
import { LEVEL_LABELS, type CatalogEntry } from "../lib/catalog";
import type { PieceProgress } from "../lib/progress";

interface Props {
  catalog: CatalogEntry[];
  progress: Record<string, PieceProgress>;
  onOpen: (entry: CatalogEntry) => void;
}

export function FeaturedScore({ catalog, progress, onOpen }: Props) {
  const featured = useMemo(() => {
    // 1. Chercher un morceau récemment joué avec du progrès
    const playedEntries = catalog.filter((e) => (progress[e.id]?.stars ?? 0) > 0);
    if (playedEntries.length > 0) {
      // Le morceau avec des étoiles
      return { entry: playedEntries[0], isResume: true };
    }
    // 2. Sinon, un morceau emblématique du catalogue
    const classic = catalog.find((e) => e.composer.includes("Fauré") || e.composer.includes("Debussy") || e.id.includes("clair-de-la-lune")) ?? catalog[0];
    return { entry: classic, isResume: false };
  }, [catalog, progress]);

  if (!featured.entry) return null;

  const { entry, isResume } = featured;
  const stars = progress[entry.id]?.stars ?? 0;
  const hasPiano = partnersOf(entry).includes("piano") || entry.kind === "piano";
  const isDuo = partnersOf(entry).includes("flute");

  return (
    <section className="featured-section" aria-label="Morceau mis en avant">
      <div className={`featured-card lvl${entry.level}`}>
        <div className="featured-banner-label">
          <span>{isResume ? "🌟 Reprendre votre pratique" : "✨ Morceau recommandé pour commencer"}</span>
          <span className="featured-level-pill">
            {"●".repeat(entry.level)} {LEVEL_LABELS[entry.level]}
          </span>
        </div>

        <div className="featured-main-info">
          <div className="featured-text">
            <h2 className="featured-title">{entry.title}</h2>
            <p className="featured-composer">🎼 {entry.composer}</p>
            <div className="featured-tags">
              {entry.key && <span className="feat-tag">Tonalité : {entry.key}</span>}
              {entry.time && <span className="feat-tag">Mesure : {entry.time}</span>}
              {entry.range && <span className="feat-tag">Tessiture : {entry.range.low}–{entry.range.high}</span>}
              {hasPiano && <span className="feat-tag piano">🎹 Accompagnement piano</span>}
              {isDuo && <span className="feat-tag duo">🎶 Duo de flûtes</span>}
            </div>
          </div>

          <div className="featured-actions-panel">
            <div className="featured-progress-indicator">
              <span className="stars-label">Maîtrise :</span>
              <span className="stars-glow">
                {[1, 2, 3].map((n) => (n <= stars ? "★" : "☆")).join("")}
              </span>
            </div>

            <div className="featured-btn-group">
              <button className="primary featured-play-btn" onClick={() => onOpen(entry)}>
                ▶ Jouer maintenant
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
