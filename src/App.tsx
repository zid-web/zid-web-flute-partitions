import { useCallback, useEffect, useMemo, useState } from "react";
import { Library } from "./components/Library";
import { Player } from "./components/Player";
import { loadCatalog, type CatalogEntry } from "./lib/catalog";
import { loadProgress, type PieceProgress } from "./lib/progress";
import { deleteUserScore, listUserScores } from "./lib/userScores";

export function App() {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [userScores, setUserScores] = useState<CatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<CatalogEntry | null>(null);
  const [progress, setProgress] = useState<Record<string, PieceProgress>>(loadProgress);

  useEffect(() => {
    loadCatalog().then(setCatalog, (e: Error) => setError(e.message));
    void listUserScores().then(setUserScores);
  }, []);

  const all = useMemo(() => [...userScores, ...(catalog ?? [])], [catalog, userScores]);

  const removeUserScore = useCallback(async (entry: CatalogEntry) => {
    try {
      await deleteUserScore(entry.id);
    } finally {
      setUserScores(await listUserScores());
    }
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
    <Library
      catalog={all}
      progress={progress}
      onOpen={setCurrent}
      onImported={(entry) => setUserScores((list) => [entry, ...list])}
      onDelete={(entry) => void removeUserScore(entry)}
    />
  );
}
