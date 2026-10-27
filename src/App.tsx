import { useEffect, useState } from "react";
import { Library } from "./components/Library";
import { Player } from "./components/Player";
import { loadCatalog, type CatalogEntry } from "./lib/catalog";
import { loadProgress, type PieceProgress } from "./lib/progress";

export function App() {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<CatalogEntry | null>(null);
  const [progress, setProgress] = useState<Record<string, PieceProgress>>(loadProgress);

  useEffect(() => {
    loadCatalog().then(setCatalog, (e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="message">⚠️ {error}</p>;
  if (!catalog) return <p className="message">Chargement des partitions…</p>;

  return current ? (
    <Player
      entry={current}
      onBack={() => setCurrent(null)}
      onProgress={setProgress}
      bestStars={progress[current.id]?.stars ?? 0}
    />
  ) : (
    <Library catalog={catalog} progress={progress} onOpen={setCurrent} />
  );
}
