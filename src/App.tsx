import { useCallback, useEffect, useMemo, useState } from "react";
import { ImportIndicator } from "./components/ImportIndicator";
import { useImportStatus } from "./components/ImportButton";
import { Library } from "./components/Library";
import { MyFlute } from "./components/MyFlute";
import { Player } from "./components/Player";
import { onUpdateWaiting, setBusy } from "./lib/appUpdate";
import { loadCatalog, type CatalogEntry } from "./lib/catalog";
import { startContentSync } from "./lib/contentSync";
import { listTakes } from "./lib/myFlute";
import { onScoreImported } from "./lib/importJobs";
import { movementsOf } from "./lib/movements";
import { openDownloadPage, UpdateError, updateErrorMessage, watchNativeUpdates, type NativeUpdate } from "./lib/nativeUpdate";
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
  // Application de bureau : nouvelle version publiée, proposée dans la bibliothèque.
  const [nativeUpdate, setNativeUpdate] = useState<NativeUpdate | null>(null);
  // l'application ne redémarre pas pour une mise à jour pendant un import
  const importStatus = useImportStatus();
  const [installing, setInstalling] = useState<number | null | "error" | undefined>(undefined);
  const [updateError, setUpdateError] = useState<{ message: string; installed: boolean } | null>(null);

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
    const stopNative = watchNativeUpdates(setNativeUpdate);
    // Partitions importées en arrière-plan, même si l'on a quitté la bibliothèque entre-temps.
    const stopImported = onScoreImported((entry) => {
      setUserScores((list) => [entry, ...list.filter((e) => e.id !== entry.id)]);
      void requestPersistentStorage();
    });
    return () => {
      stopSync();
      stopWaiting();
      stopNative();
      stopImported();
    };
  }, []);

  // Une mise à jour de l'application n'est jamais installée pendant un morceau.
  useEffect(() => setBusy(current !== null || myFlute || importStatus.kind === "busy"), [current, myFlute, importStatus.kind]);

  useEffect(() => {
    if (!news) return;
    const t = window.setTimeout(() => setNews(null), 6000);
    return () => clearTimeout(t);
  }, [news]);

  const installNativeUpdate = useCallback(async () => {
    if (!nativeUpdate) return;
    setInstalling(null);
    setUpdateError(null);
    try {
      await nativeUpdate.install((f) => setInstalling(f));
    } catch (e) {
      setUpdateError(
        e instanceof UpdateError
          ? { message: e.message, installed: e.installed }
          : { message: updateErrorMessage(e), installed: false },
      );
      setInstalling("error");
    }
  }, [nativeUpdate]);

  const all = useMemo(() => [...userScores, ...(catalog ?? [])], [catalog, userScores]);
  const movements = useMemo(() => (current ? movementsOf(current, all) : []), [current, all]);

  const removeUserScores = useCallback(async (entries: CatalogEntry[]) => {
    try {
      for (const entry of entries) await deleteUserScore(entry.id);
    } finally {
      setUserScores(await listUserScores());
    }
  }, []);

  /** Sauvegarde (partitions importées + notes de « Ma flûte ») ; renvoie le message à afficher. */
  const backupUserScores = useCallback(async (): Promise<string | null> => {
    const date = new Date().toISOString().slice(0, 10);
    return saveFile(await exportUserScores(), `mes-partitions-flute-${date}.json`, "application/json");
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
      {/* Jamais pendant un morceau : uniquement depuis la bibliothèque. */}
      {/* hors de la bibliothèque : l'import continue, sa pastille reste visible */}
      {(current || myFlute) && (
        <ImportIndicator
          onShow={() => {
            setCurrent(null);
            setMyFlute(false);
          }}
        />
      )}
      {nativeUpdate && !current && !myFlute && importStatus.kind !== "busy" && (
        <div className="update-banner" role="status">
          {installing === undefined ? (
            <>
              <span>
                ✨ Nouvelle version <b>{nativeUpdate.version}</b> disponible
              </span>
              <button className="primary" onClick={() => void installNativeUpdate()}>
                Installer et redémarrer
              </button>
              <button className="ghost" onClick={() => setNativeUpdate(null)} title="Plus tard">
                Plus tard
              </button>
            </>
          ) : installing === "error" ? (
            <>
              <span>
                {updateError?.installed ? "✅" : "⚠️"} {updateError?.message ?? "La mise à jour n'a pas pu être installée."}
              </span>
              {!updateError?.installed && (
                <>
                  <button onClick={() => void installNativeUpdate()}>Réessayer</button>
                  <button className="primary" onClick={() => void openDownloadPage()} title="Ouvre la page de téléchargement dans le navigateur">
                    Télécharger la version {nativeUpdate.version}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <span>
                ⬇️ Téléchargement de la version {nativeUpdate.version}
                {installing !== null && ` : ${Math.round(installing * 100)} %`}… l'application va redémarrer.
              </span>
              <span className="update-progress" aria-hidden>
                <span style={{ width: `${Math.round((installing ?? 0.05) * 100)}%` }} />
              </span>
            </>
          )}
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
        <MyFlute onBack={() => setMyFlute(false)} onBackup={backupUserScores} onRestore={restoreBackup} />
      ) : (
        <Library
          onMyFlute={() => setMyFlute(true)}
          catalog={all}
          progress={progress}
          onOpen={(entry) => {
            setAutoListen(false);
            setCurrent(entry);
          }}
          onBackup={backupUserScores}
          onRestore={restoreBackup}
          onDelete={(entries) => void removeUserScores(entries)}
        />
      )}
    </>
  );
}
