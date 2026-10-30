import { useCallback, useEffect, useMemo, useState } from "react";
import { Library } from "./components/Library";
import { Player } from "./components/Player";
import { onUpdateWaiting, setBusy } from "./lib/appUpdate";
import { loadCatalog, type CatalogEntry } from "./lib/catalog";
import { startContentSync } from "./lib/contentSync";
import { loadProgress, type PieceProgress } from "./lib/progress";
import { saveFile } from "./lib/saveFile";
import {
  deleteUserScore,
  exportUserScores,
  listUserScores,
  requestPersistentStorage,
  restoreUserScores,
} from "./lib/userScores";

export function App() {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [userScores, setUserScores] = useState<CatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<CatalogEntry | null>(null);
  const [progress, setProgress] = useState<Record<string, PieceProgress>>(loadProgress);
  const [news, setNews] = useState<string | null>(null);
  const [updateWaiting, setUpdateWaiting] = useState(false);

  useEffect(() => {
    let stopSync = () => {};
    loadCatalog().then(
      ({ catalog, bundled }) => {
        setCatalog(catalog);
        // Applications natives : nouveaux morceaux publiés depuis l'installation, sans réinstaller.
        stopSync = startContentSync(bundled, (next, added) => {
          setCatalog(next);
          if (added.length) {
            setNews(
              added.length === 1
                ? `🎉 Nouveau morceau : « ${added[0].title} »`
                : `🎉 ${added.length} nouveaux morceaux dans la bibliothèque`,
            );
          }
        });
      },
      (e: Error) => setError(e.message),
    );
    void listUserScores().then((list) => {
      setUserScores(list);
      // Des partitions importées sur cet appareil : on demande qu'elles ne soient jamais effacées.
      if (list.length > 0) void requestPersistentStorage();
    });
    const stopWaiting = onUpdateWaiting(setUpdateWaiting);
    return () => {
      stopSync();
      stopWaiting();
    };
  }, []);

  // Une mise à jour de l'application n'est jamais installée pendant un morceau.
  useEffect(() => setBusy(current !== null), [current]);

  useEffect(() => {
    if (!news) return;
    const t = window.setTimeout(() => setNews(null), 6000);
    return () => clearTimeout(t);
  }, [news]);

  const all = useMemo(() => [...userScores, ...(catalog ?? [])], [catalog, userScores]);

  const removeUserScores = useCallback(async (entries: CatalogEntry[]) => {
    try {
      for (const entry of entries) await deleteUserScore(entry.id);
    } finally {
      setUserScores(await listUserScores());
    }
  }, []);

  const backupUserScores = useCallback(async () => {
    const date = new Date().toISOString().slice(0, 10);
    await saveFile(await exportUserScores(), `mes-partitions-flute-${date}.json`, "application/json");
  }, []);

  const restoreBackup = useCallback(async (file: File): Promise<string> => {
    const count = await restoreUserScores(await file.text());
    setUserScores(await listUserScores());
    void requestPersistentStorage();
    return count === 0 ? "Aucune partition dans cette sauvegarde." : `${count} partition${count > 1 ? "s" : ""} restaurée${count > 1 ? "s" : ""}.`;
  }, []);

  if (error) return <p className="message">⚠️ {error}</p>;
  if (!catalog) return <p className="message">Chargement des partitions…</p>;

  const banners = (
    <>
      {news && (
        <div className="toast" role="status">
          {news}
        </div>
      )}
      {updateWaiting && current && (
        <div className="toast" role="status">
          ✨ Nouvelle version prête : elle s'installera à la fin du morceau.
        </div>
      )}
    </>
  );

  return (
    <>
      {banners}
      {current ? (
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
          onImported={(entry) => {
            setUserScores((list) => [entry, ...list]);
            void requestPersistentStorage();
          }}
          onBackup={backupUserScores}
          onRestore={restoreBackup}
          onDelete={(entries) => void removeUserScores(entries)}
        />
      )}
    </>
  );
}
