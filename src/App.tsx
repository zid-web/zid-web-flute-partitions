import { useCallback, useEffect, useMemo, useState } from "react";
import { Library } from "./components/Library";
import { MyFlute } from "./components/MyFlute";
import { Player } from "./components/Player";
import { onUpdateWaiting, setBusy } from "./lib/appUpdate";
import { loadCatalog, type CatalogEntry } from "./lib/catalog";
import { startContentSync } from "./lib/contentSync";
import { listTakes } from "./lib/myFlute";
import { movementsOf } from "./lib/movements";
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
  // Mouvement ouvert par l'enchaînement de l'écoute : il se joue dès qu'il est prêt.
  const [autoListen, setAutoListen] = useState(false);
  const [myFlute, setMyFlute] = useState(false);
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
    void Promise.all([listUserScores(), listTakes()]).then(([list, takes]) => {
      setUserScores(list);
      // Des partitions importées ou des notes de « Ma flûte » sur cet appareil : on demande au
      // navigateur de ne jamais les effacer (sinon, il peut vider le stockage quand l'appareil est plein).
      if (list.length > 0 || takes.length > 0) void requestPersistentStorage();
    });
    const stopWaiting = onUpdateWaiting(setUpdateWaiting);
    return () => {
      stopSync();
      stopWaiting();
    };
  }, []);

  // Une mise à jour de l'application n'est jamais installée pendant un morceau.
  useEffect(() => setBusy(current !== null || myFlute), [current, myFlute]);

  useEffect(() => {
    if (!news) return;
    const t = window.setTimeout(() => setNews(null), 6000);
    return () => clearTimeout(t);
  }, [news]);

  const all = useMemo(() => [...userScores, ...(catalog ?? [])], [catalog, userScores]);
  const movements = useMemo(() => (current ? movementsOf(current, all) : []), [current, all]);

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
    const { scores, takes } = await restoreUserScores(await file.text());
    setUserScores(await listUserScores());
    void requestPersistentStorage();
    const parts = [
      ...(scores ? [`${scores} partition${scores > 1 ? "s" : ""}`] : []),
      ...(takes ? [`${takes} note${takes > 1 ? "s" : ""} de « Ma flûte »`] : []),
    ];
    return parts.length === 0 ? "Rien à restaurer dans cette sauvegarde." : `Restauré : ${parts.join(" et ")}.`;
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
          key={current.id}
          entry={current}
          movements={movements}
          autoListen={autoListen}
          onOpenMovement={(entry, listen) => {
            setAutoListen(listen);
            setCurrent(entry);
          }}
          onBack={() => setCurrent(null)}
          onProgress={setProgress}
          bestStars={progress[current.id]?.stars ?? 0}
        />
      ) : myFlute ? (
        <MyFlute onBack={() => setMyFlute(false)} />
      ) : (
        <Library
          onMyFlute={() => setMyFlute(true)}
          catalog={all}
          progress={progress}
          onOpen={(entry) => {
            setAutoListen(false);
            setCurrent(entry);
          }}
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
