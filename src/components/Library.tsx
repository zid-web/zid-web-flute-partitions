import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { partnersOf } from "../lib/accompaniment";
import { LEVEL_LABELS, type CatalogEntry } from "../lib/catalog";
import type { PieceProgress } from "../lib/progress";
import { groupWorks, movementLabel, type LibraryItem } from "../lib/libraryView";
import { groupHeadings, loadSortKey, saveSortKey, SORT_LABELS, sortEntries, type SortKey } from "../lib/sortScores";
import { ImportButton } from "./ImportButton";

interface Props {
  catalog: CatalogEntry[];
  progress: Record<string, PieceProgress>;
  onOpen: (entry: CatalogEntry) => void;
  onImported: (entry: CatalogEntry) => void;
  onDelete: (entries: CatalogEntry[]) => void;
  /** Enregistre un fichier de sauvegarde des partitions importées. */
  /** Sauvegarde ; renvoie le message à afficher (où est le fichier), ou null si annulée. */
  onBackup: () => Promise<string | null>;
  /** Restaure un fichier de sauvegarde ; renvoie le message à afficher. */
  onRestore: (file: File) => Promise<string>;
  /** Ouvre « Ma flûte » (enregistrer le son de sa flûte). */
  onMyFlute: () => void;
}

const LEVELS = [1, 2, 3, 4, 5] as const;
const SORT_KEYS = Object.keys(SORT_LABELS) as SortKey[];
const dateFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
type Tab = "all" | "mine" | "library";
type View = "grid" | "list";
const VIEW_KEY = "flute-partitions:vue";
const NEW_FOR_MS = 24 * 3600 * 1000;
/** Délai pour annuler une suppression. */
const UNDO_MS = 6000;

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function Library({ catalog, progress, onOpen, onImported, onDelete, onBackup, onRestore, onMyFlute }: Props) {
  const restoreInput = useRef<HTMLInputElement>(null);
  const [backupMessage, setBackupMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [level, setLevel] = useState<CatalogEntry["level"] | 0>(0);
  const [tab, setTab] = useState<Tab>("all");
  const [view, setView] = useState<View>(loadView);
  // Partition qu'on vient d'importer : mise en évidence et amenée à l'écran.
  const [fresh, setFresh] = useState<string | null>(null);
  // Suppression en attente (annulable quelques secondes) : les partitions disparaissent tout de suite.
  const [pending, setPending] = useState<{ entries: CatalogEntry[]; timer: number } | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  // En quittant la bibliothèque (ouverture d'un morceau…), la suppression en attente est faite.
  useEffect(
    () => () => {
      const p = pendingRef.current;
      if (p) {
        clearTimeout(p.timer);
        onDelete(p.entries);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [pianoFilter, setPianoFilter] = useState(false);
  const [duoFilter, setDuoFilter] = useState(false);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>(loadSortKey);
  // Mode « Supprimer plusieurs » : on coche des partitions importées au lieu de les ouvrir.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const hidden = new Set(pending?.entries.map((e) => e.id) ?? []);
  const visible = catalog.filter((e) => !hidden.has(e.id));
  const mineCount = visible.filter((e) => e.origin === "import").length;
  const libraryCount = visible.length - mineCount;
  // Partitions avec une partie de piano (accompagnement ou piano seul), repérées à l'import.
  const withPiano = (e: CatalogEntry) => e.kind === "piano" || partnersOf(e).includes("piano");
  const isDuo = (e: CatalogEntry) => partnersOf(e).includes("flute");
  const pianoCount = catalog.filter(withPiano).length;
  const duoCount = catalog.filter(isDuo).length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = visible
      .filter((e) => !(tab === "mine" || selecting) || e.origin === "import")
      .filter((e) => tab !== "library" || selecting || e.origin !== "import")
      .filter((e) => !pianoFilter || withPiano(e))
      .filter((e) => !duoFilter || isDuo(e))
      .filter((e) => level === 0 || e.level === level)
      .filter((e) => !q || `${e.title} ${e.composer}`.toLowerCase().includes(q));
    return sortEntries(filtered, sortKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, pending, level, tab, pianoFilter, duoFilter, selecting, query, sortKey]);
  // Œuvres en plusieurs mouvements : une seule carte (sauf pendant la sélection pour supprimer).
  const items: LibraryItem[] = useMemo(
    () => (selecting ? shown.map((e) => ({ key: e.id, entries: [e], title: e.title })) : groupWorks(shown, visible)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, selecting],
  );
  const headings = useMemo(() => groupHeadings(items.map((i) => i.entries[0]), sortKey), [items, sortKey]);

  function changeView(v: View) {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* préférence non mémorisée */
    }
  }

  /** Supprime tout de suite de l'écran ; vraiment effacé après quelques secondes, sauf « Annuler ». */
  function remove(entries: CatalogEntry[]) {
    if (pending) {
      clearTimeout(pending.timer);
      onDelete(pending.entries);
    }
    const timer = window.setTimeout(() => {
      onDelete(entries);
      setPending(null);
    }, UNDO_MS);
    setPending({ entries, timer });
  }

  function undo() {
    if (!pending) return;
    clearTimeout(pending.timer);
    setPending(null);
  }

  useEffect(() => {
    if (!fresh) return;
    document.querySelector(`[data-entry="${CSS.escape(fresh)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = window.setTimeout(() => setFresh(null), 4000);
    return () => clearTimeout(t);
  }, [fresh]);

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
    remove(entries);
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
            Il reste sur cet appareil et fonctionne hors ligne. Une partie de piano est repérée et gardée : 🎹 le
            piano vous accompagne ; une partition pour piano seul s'écoute au piano. Dans un duo de flûtes, vous jouez la 1ʳᵉ
            flûte et l'application joue la 2ᵉ.
          </li>
          <li>
            <b>Ranger</b> : « Trier par » classe les morceaux par niveau, date d'import, compositeur ou titre.
            Onglets <b>Mes partitions</b> / <b>Bibliothèque</b>, affichage en grille ou en liste. Une œuvre en
            plusieurs mouvements tient sur une seule carte. <b>🗑</b> supprime une partition importée (« Annuler »
            pendant quelques secondes) ; <b>🗑 Sélectionner…</b> en supprime plusieurs d'un coup.
          </li>
          <li>
            <b>🎙️ Ma flûte</b> : enregistrez quelques notes de votre flûte ; « Écouter » jouera ensuite les partitions
            avec votre son.
          </li>
          <li>
            <b>💾 Sauvegarder</b> enregistre une copie de vos partitions importées et de vos notes « Ma flûte » ;{" "}
            <b>♻️ Restaurer</b> les remet
            dans l'application (après une réinstallation, ou sur un autre appareil).
          </li>
        </ol>
      </details>

      <nav className="tabs" aria-label="Partitions">
        {(
          [
            ["all", `Tout (${visible.length})`],
            ["mine", `📥 Mes partitions (${mineCount})`],
            ["library", `📚 Bibliothèque (${libraryCount})`],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} className={tab === t ? "tab active" : "tab"} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
        <span className="view-toggle" role="group" aria-label="Affichage">
          <button className={view === "grid" ? "active" : ""} onClick={() => changeView("grid")} title="Grille" aria-label="Affichage en grille">
            ▦
          </button>
          <button className={view === "list" ? "active" : ""} onClick={() => changeView("list")} title="Liste" aria-label="Affichage en liste">
            ☰
          </button>
        </span>
      </nav>

      <div className="filters">
        <button className={level === 0 ? "chip active" : "chip"} onClick={() => setLevel(0)}>
          Tous
        </button>
        {LEVELS.map((l) => (
          <button key={l} className={level === l ? `chip active lvl${l}` : `chip lvl${l}`} onClick={() => setLevel(l)}>
            {"●".repeat(l)} {LEVEL_LABELS[l]}
          </button>
        ))}
        {pianoCount > 0 && (
          <button className={pianoFilter ? "chip active" : "chip"} onClick={() => setPianoFilter((p) => !p)}>
            🎹 Avec piano ({pianoCount})
          </button>
        )}
        {duoCount > 0 && (
          <button className={duoFilter ? "chip active" : "chip"} onClick={() => setDuoFilter((d) => !d)}>
            🎶 Duos de flûtes ({duoCount})
          </button>
        )}
        <span className="search-box">
          <span aria-hidden>🔍</span>
          <input
            className="search"
            type="search"
            placeholder="Titre ou compositeur…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="clear" onClick={() => setQuery("")} aria-label="Effacer la recherche">
              ✕
            </button>
          )}
        </span>
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
            <button
              className="ghost"
              title="Enregistrer une copie de vos partitions importées et de vos notes « Ma flûte » (à garder en lieu sûr)"
              onClick={() => {
                setBackupMessage(null);
                onBackup().then(
                  (text) => text && setBackupMessage({ text: `✅ ${text}` }),
                  (e: unknown) =>
                    setBackupMessage({ text: `Sauvegarde impossible : ${e instanceof Error ? e.message : String(e)}`, error: true }),
                );
              }}
            >
              💾 Sauvegarder
            </button>
            <button className="ghost" title="Récupérer partitions et notes « Ma flûte » depuis un fichier de sauvegarde" onClick={() => restoreInput.current?.click()}>
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
              🗑 Sélectionner…
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
            setTab("mine");
            setLevel(0);
            setQuery("");
            setFresh(entry.id);
            onImported(entry);
          }}
        />
      )}

      {pending && (
        <div className="toast undo" role="status">
          🗑 {pending.entries.length === 1 ? `« ${pending.entries[0].title} » supprimée` : `${pending.entries.length} partitions supprimées`}
          <button onClick={undo}>Annuler</button>
        </div>
      )}

      <ul className={view === "list" ? "cards list" : "cards"}>
        {items.map((item, i) => {
          const e = item.entries[0];
          const work = item.entries.length > 1;
          const stars = Math.max(...item.entries.map((m) => progress[m.id]?.stars ?? 0));
          const checked = selected.has(e.id);
          const isNew = item.entries.some((m) => m.addedAt !== undefined && Date.now() - m.addedAt < NEW_FOR_MS);
          const imported = e.origin === "import";
          return (
            <Fragment key={item.key}>
              {headings[i] && <li className="group-heading">{headings[i]}</li>}
              <li className={`card-slot${item.entries.some((m) => m.id === fresh) ? " fresh" : ""}`} data-entry={e.id}>
                <div
                  role="button"
                  tabIndex={0}
                  className={`card lvl${e.level}${selecting ? " selectable" : ""}${checked ? " selected" : ""}${work ? " work" : ""}`}
                  onClick={() => (selecting ? toggle(e.id) : onOpen(e))}
                  onKeyDown={(k) => {
                    if (k.key === "Enter" || k.key === " ") {
                      k.preventDefault();
                      if (selecting) toggle(e.id);
                      else onOpen(e);
                    }
                  }}
                  aria-pressed={selecting ? checked : undefined}
                >
                  {selecting && (
                    <span className="check" aria-hidden>
                      {checked ? "☑" : "☐"}
                    </span>
                  )}
                  <span className="level-badge">
                    {"●".repeat(e.level)} {LEVEL_LABELS[e.level]}
                    {isNew && <span className="mine-badge new">Nouveau</span>}
                    {imported && !isNew && <span className="mine-badge">importée</span>}
                    {partnersOf(e).includes("piano") && (
                      <span className="mine-badge" title="Flûte accompagnée au piano">
                        🎹 avec piano
                      </span>
                    )}
                    {partnersOf(e).includes("flute") && (
                      <span className="mine-badge" title="Duo : vous jouez la 1ʳᵉ flûte, l'application la 2ᵉ">
                        🎶 duo
                      </span>
                    )}
                    {e.kind === "piano" && (
                      <span className="mine-badge" title="Partition pour piano : à écouter">
                        🎹 piano seul
                      </span>
                    )}
                    {e.origin === "omr" && (
                      <span className="mine-badge" title="Reconnue automatiquement à partir d'un PDF scanné">
                        🔍 reconnue
                      </span>
                    )}
                  </span>
                  <strong className="title">{item.title}</strong>
                  <span className="composer">{e.composer}</span>
                  {work ? (
                    <span className="movements" onClick={(ev) => ev.stopPropagation()}>
                      <small>🎼 {item.entries.length} mouvements</small>
                      {item.entries.map((m, k) => (
                        <button key={m.id} className="movement" onClick={() => onOpen(m)} title={`Ouvrir ${m.title}`}>
                          {movementLabel(m, item.title, k)}
                          {(progress[m.id]?.stars ?? 0) > 0 && <span className="mini-stars"> {"★".repeat(progress[m.id].stars)}</span>}
                        </button>
                      ))}
                    </span>
                  ) : (
                    <span className="meta">
                      {e.key && <>🎼 {e.key} </>}
                      {e.time && <>· {e.time} </>}
                      {e.range && (
                        <>
                          · {e.range.low}–{e.range.high}
                        </>
                      )}
                    </span>
                  )}
                  {e.addedAt !== undefined && <span className="added">Importée le {dateFormat.format(e.addedAt)}</span>}
                  <span className="card-foot">
                    <span className="complexity" aria-label={`Complexité ${e.complexity} sur 100`}>
                      <span style={{ width: `${e.complexity}%` }} />
                    </span>
                    <span className="stars">{[1, 2, 3].map((n) => (n <= stars ? "★" : "☆")).join("")}</span>
                  </span>
                </div>
                {imported && !selecting && (
                  <button
                    className="delete"
                    aria-label={`Supprimer ${item.title}`}
                    title={work ? `Supprimer l'œuvre (${item.entries.length} mouvements) de cet appareil` : "Supprimer de cet appareil"}
                    onClick={() => remove(item.entries)}
                  >
                    🗑
                  </button>
                )}
              </li>
            </Fragment>
          );
        })}
        {items.length === 0 && (
          <li className="message empty">
            {tab === "mine" && mineCount === 0
              ? "📥 Aucune partition importée pour l'instant : utilisez « Importer une partition » ci-dessus."
              : "Aucun morceau pour ce filtre."}
          </li>
        )}
      </ul>
      <footer className="credits">
        Partitions du domaine public (IMSLP et répertoire traditionnel). Fonctionne hors ligne. Les partitions
        importées restent sur cet appareil. Version {__APP_VERSION__}, mise à jour automatique.
        <br />
        Sons : flûte VSCO-2 Community Edition, Versilian Studios (CC0) ; piano Salamander Grand Piano, Alexander Holm
        (CC-BY 3.0).
      </footer>
    </main>
  );
}
