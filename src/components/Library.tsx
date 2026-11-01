import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { partnersOf } from "../lib/accompaniment";
import { LEVEL_LABELS, type CatalogEntry } from "../lib/catalog";
import type { PieceProgress } from "../lib/progress";
import { groupWorks, movementLabel, type LibraryItem } from "../lib/libraryView";
import { groupHeadings, loadSortKey, saveSortKey, SORT_LABELS, sortEntries, type SortKey } from "../lib/sortScores";
import { ImportButton } from "./ImportButton";
import { HomeHero } from "./HomeHero";
import { FluteExplorer } from "./FluteExplorer";
import { HowItWorks } from "./HowItWorks";
import { FeaturedScore } from "./FeaturedScore";

interface Props {
  catalog: CatalogEntry[];
  progress: Record<string, PieceProgress>;
  onOpen: (entry: CatalogEntry) => void;
  onImported: (entry: CatalogEntry) => void;
  onDelete: (entries: CatalogEntry[]) => void;
  onBackup: () => Promise<string | null>;
  onRestore: (file: File) => Promise<string>;
  onMyFlute: () => void;
}

const LEVELS = [1, 2, 3, 4, 5] as const;
const SORT_KEYS = Object.keys(SORT_LABELS) as SortKey[];
const dateFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
type Tab = "all" | "mine" | "library";
type View = "grid" | "list";
const VIEW_KEY = "flute-partitions:vue";
const THEME_KEY = "flute-partitions:theme";
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

function loadInitialTheme(): "dark" | "light" {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function Library({
  catalog,
  progress,
  onOpen,
  onImported,
  onDelete,
  onBackup,
  onRestore,
  onMyFlute,
}: Props) {
  const restoreInput = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const catalogSectionRef = useRef<HTMLElement>(null);
  const importSectionRef = useRef<HTMLDivElement>(null);

  const [theme, setTheme] = useState<"dark" | "light">(loadInitialTheme);
  const [backupMessage, setBackupMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [level, setLevel] = useState<CatalogEntry["level"] | 0>(0);
  const [tab, setTab] = useState<Tab>("all");
  const [view, setView] = useState<View>(loadView);
  const [isExplorerOpen, setIsExplorerOpen] = useState(false);
  const [playedFilter, setPlayedFilter] = useState(false);

  // Partition qu'on vient d'importer : mise en évidence et amenée à l'écran.
  const [fresh, setFresh] = useState<string | null>(null);

  // Suppression en attente (annulable quelques secondes) : les partitions disparaissent tout de suite.
  const [pending, setPending] = useState<{ entries: CatalogEntry[]; timer: number } | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  // Gestion du thème sombre / clair
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  function toggleTheme() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  // Raccourci clavier pour la recherche (/ ou Cmd/Ctrl + K)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key === "k")) && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // En quittant la bibliothèque, la suppression en attente est appliquée.
  useEffect(
    () => () => {
      const p = pendingRef.current;
      if (p) {
        clearTimeout(p.timer);
        onDelete(p.entries);
      }
    },
    [onDelete],
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

  // Partitions avec une partie de piano (accompagnement ou piano seul)
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
      .filter((e) => !playedFilter || (progress[e.id]?.stars ?? 0) > 0)
      .filter((e) => level === 0 || e.level === level)
      .filter((e) => !q || `${e.title} ${e.composer}`.toLowerCase().includes(q));
    return sortEntries(filtered, sortKey);
  }, [visible, tab, selecting, pianoFilter, duoFilter, playedFilter, level, query, sortKey, progress]);

  // Œuvres en plusieurs mouvements : une seule carte (sauf pendant la sélection pour supprimer).
  const items: LibraryItem[] = useMemo(
    () => (selecting ? shown.map((e) => ({ key: e.id, entries: [e], title: e.title })) : groupWorks(shown, visible)),
    [shown, selecting, visible],
  );

  const headings = useMemo(() => groupHeadings(items.map((i) => i.entries[0]), sortKey), [items, sortKey]);

  function changeView(v: View) {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // ignore
    }
  }

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

  function scrollToScores() {
    catalogSectionRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  function scrollToImport() {
    importSectionRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  return (
    <main className="library-modern">
      {/* Barre de navigation supérieure moderne */}
      <header className="navbar-modern">
        <div className="navbar-brand">
          <span className="brand-icon">🎶</span>
          <div className="brand-text">
            <span className="brand-title">Flûte Partitions</span>
            <span className="brand-subtitle">Studio d'apprentissage interactif</span>
          </div>
        </div>

        <div className="navbar-actions">
          <div className="star-total-badge" title="Total des étoiles obtenues sur vos morceaux">
            ⭐ <span>{totalStars}</span>
          </div>

          <button
            className="navbar-btn highlight"
            onClick={onMyFlute}
            title="Enregistrer le son de votre propre flûte"
          >
            🎙️ <span className="btn-text">Ma flûte</span>
          </button>

          <button
            className="navbar-btn theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Passer en mode jour" : "Passer en mode concert sombre"}
            aria-label="Basculer le thème"
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>
      </header>

      {/* Bannière Hero d'accueil interactive */}
      <HomeHero
        totalStars={totalStars}
        totalScores={visible.length}
        userScoreCount={mineCount}
        pianoCount={pianoCount}
        duoCount={duoCount}
        isExplorerOpen={isExplorerOpen}
        onToggleExplorer={() => setIsExplorerOpen((v) => !v)}
        onExploreScores={scrollToScores}
        onMyFlute={onMyFlute}
        onOpenImport={scrollToImport}
      />

      {/* Accordeur et découverte des sons interactif */}
      {isExplorerOpen && (
        <FluteExplorer onClose={() => setIsExplorerOpen(false)} />
      )}

      {/* Morceau recommandé ou reprise de session */}
      <FeaturedScore catalog={visible} progress={progress} onOpen={onOpen} />

      {/* Guide visuel interactif */}
      <HowItWorks />

      {/* Section principale du catalogue */}
      <section ref={catalogSectionRef} className="catalog-section" aria-label="Catalogue de partitions">
        <div className="section-title-row">
          <div>
            <h2 className="section-heading">📚 Bibliothèque Musicale</h2>
            <p className="section-subheading">
              {shown.length} {shown.length > 1 ? "partitions disponibles" : "partition disponible"} selon vos critères
            </p>
          </div>
        </div>

        {/* Onglets principaux et sélecteur de vue */}
        <nav className="tabs" aria-label="Catégories de partitions">
          {(
            [
              ["all", `Tout (${visible.length})`],
              ["mine", `📥 Mes partitions (${mineCount})`],
              ["library", `📚 Bibliothèque (${libraryCount})`],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button
              key={t}
              className={tab === t ? "tab active" : "tab"}
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          ))}

          <span className="view-toggle" role="group" aria-label="Mode d'affichage">
            <button
              className={view === "grid" ? "active" : ""}
              onClick={() => changeView("grid")}
              title="Affichage en cartes"
              aria-label="Affichage en grille"
            >
              ▦
            </button>
            <button
              className={view === "list" ? "active" : ""}
              onClick={() => changeView("list")}
              title="Affichage en liste"
              aria-label="Affichage en liste"
            >
              ☰
            </button>
          </span>
        </nav>

        {/* Barre de filtres par niveaux, options et recherche */}
        <div className="filters-bar">
          <div className="level-chips">
            <button className={level === 0 ? "chip active" : "chip"} onClick={() => setLevel(0)}>
              Tous niveaux
            </button>
            {LEVELS.map((l) => (
              <button
                key={l}
                className={level === l ? `chip active lvl${l}` : `chip lvl${l}`}
                onClick={() => setLevel(l)}
              >
                {"●".repeat(l)} {LEVEL_LABELS[l]}
              </button>
            ))}
          </div>

          <div className="feature-chips">
            {pianoCount > 0 && (
              <button
                className={pianoFilter ? "chip active" : "chip"}
                onClick={() => setPianoFilter((p) => !p)}
              >
                🎹 Avec piano ({pianoCount})
              </button>
            )}
            {duoCount > 0 && (
              <button
                className={duoFilter ? "chip active" : "chip"}
                onClick={() => setDuoFilter((d) => !d)}
              >
                🎶 Duos ({duoCount})
              </button>
            )}
            <button
              className={playedFilter ? "chip active" : "chip"}
              onClick={() => setPlayedFilter((p) => !p)}
            >
              ⭐ Morceaux joués
            </button>
          </div>

          <div className="search-box">
            <span aria-hidden="true">🔍</span>
            <input
              ref={searchInputRef}
              className="search"
              type="search"
              placeholder="Rechercher par titre ou compositeur (raccourci : /)..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="clear" onClick={() => setQuery("")} aria-label="Effacer la recherche">
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Barre d'agencement, tri, sauvegarde et suppression */}
        <div className="arrange-bar">
          <label className="sort">
            <span>Trier par</span>
            <select value={sortKey} onChange={(e) => changeSort(e.target.value as SortKey)}>
              {SORT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>

          {!selecting && (
            <div className="backup-actions">
              <button
                className="ghost-pill"
                title="Enregistrer une copie de vos partitions importées et de vos notes « Ma flûte »"
                onClick={() => {
                  setBackupMessage(null);
                  onBackup().then(
                    (text) => text && setBackupMessage({ text: `✅ ${text}` }),
                    (e: unknown) =>
                      setBackupMessage({
                        text: `Sauvegarde impossible : ${e instanceof Error ? e.message : String(e)}`,
                        error: true,
                      }),
                  );
                }}
              >
                💾 Sauvegarder
              </button>
              <button
                className="ghost-pill"
                title="Récupérer partitions et notes « Ma flûte » depuis un fichier de sauvegarde"
                onClick={() => restoreInput.current?.click()}
              >
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
              <button className="ghost-pill" onClick={() => setSelecting(true)}>
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

        {/* Zone d'importation de partitions */}
        <div ref={importSectionRef} className="import-wrapper">
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
        </div>

        {pending && (
          <div className="toast undo" role="status">
            🗑 {pending.entries.length === 1 ? `« ${pending.entries[0].title} » supprimée` : `${pending.entries.length} partitions supprimées`}
            <button onClick={undo}>Annuler</button>
          </div>
        )}

        {/* Liste / Grille des partitions */}
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
                <li
                  className={`card-slot${item.entries.some((m) => m.id === fresh) ? " fresh" : ""}`}
                  data-entry={e.id}
                >
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
                      <span className="check" aria-hidden="true">
                        {checked ? "☑" : "☐"}
                      </span>
                    )}

                    <div className="card-top-row">
                      <span className="level-badge">
                        {"●".repeat(e.level)} {LEVEL_LABELS[e.level]}
                      </span>
                      <div className="card-badges-group">
                        {isNew && <span className="mine-badge new">Nouveau</span>}
                        {imported && !isNew && <span className="mine-badge">Importée</span>}
                        {partnersOf(e).includes("piano") && (
                          <span className="mine-badge piano" title="Flûte accompagnée au piano">
                            🎹 Piano
                          </span>
                        )}
                        {partnersOf(e).includes("flute") && (
                          <span className="mine-badge duo" title="Duo : vous jouez la 1ʳᵉ flûte, l'application la 2ᵉ">
                            🎶 Duo
                          </span>
                        )}
                        {e.kind === "piano" && (
                          <span className="mine-badge" title="Partition pour piano : à écouter">
                            🎹 Piano seul
                          </span>
                        )}
                        {e.origin === "omr" && (
                          <span className="mine-badge omr" title="Reconnue automatiquement à partir d'un PDF scanné">
                            🔍 Reconnue
                          </span>
                        )}
                      </div>
                    </div>

                    <strong className="title">{item.title}</strong>
                    <span className="composer">{e.composer}</span>

                    {work ? (
                      <span className="movements" onClick={(ev) => ev.stopPropagation()}>
                        <small>🎼 {item.entries.length} mouvements :</small>
                        {item.entries.map((m, k) => (
                          <button
                            key={m.id}
                            className="movement"
                            onClick={() => onOpen(m)}
                            title={`Ouvrir ${m.title}`}
                          >
                            {movementLabel(m, item.title, k)}
                            {(progress[m.id]?.stars ?? 0) > 0 && (
                              <span className="mini-stars"> {"★".repeat(progress[m.id].stars)}</span>
                            )}
                          </button>
                        ))}
                      </span>
                    ) : (
                      <span className="meta">
                        {e.key && <span className="meta-item">🎼 {e.key}</span>}
                        {e.time && <span className="meta-item">· {e.time}</span>}
                        {e.range && (
                          <span className="meta-item">
                            · {e.range.low}–{e.range.high}
                          </span>
                        )}
                      </span>
                    )}

                    {e.addedAt !== undefined && (
                      <span className="added">Importée le {dateFormat.format(e.addedAt)}</span>
                    )}

                    <div className="card-foot">
                      <div className="complexity-wrap">
                        <span className="complexity-label">Complexité {e.complexity}%</span>
                        <div className="complexity" aria-label={`Complexité ${e.complexity} sur 100`}>
                          <span style={{ width: `${e.complexity}%` }} />
                        </div>
                      </div>
                      <span className="stars">
                        {[1, 2, 3].map((n) => (n <= stars ? "★" : "☆")).join("")}
                      </span>
                      <button
                        className="quick-play-btn"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onOpen(e);
                        }}
                        title={`Jouer ${item.title}`}
                      >
                        ▶ Jouer
                      </button>
                    </div>
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
                : "Aucun morceau ne correspond à votre recherche ou filtre sélectionné."}
            </li>
          )}
        </ul>
      </section>

      {/* Pied de page moderne et professionnel */}
      <footer className="credits-modern">
        <div className="credits-top">
          <div className="credits-col">
            <h4>Flûte Partitions</h4>
            <p>
              Plateforme pédagogique libre et interactive pour flûte traversière.
              Reconnaissance de son locale, respect total de la vie privée, 100% hors-ligne.
            </p>
          </div>
          <div className="credits-col">
            <h4>Ressources & Licences</h4>
            <p>
              Partitions libres issues d'IMSLP et du répertoire traditionnel français.
              Sons de flûte : VSCO-2 Community Edition (CC0). Piano : Salamander Grand Piano (CC-BY 3.0).
            </p>
          </div>
          <div className="credits-col">
            <h4>Application</h4>
            <p>
              Version {__APP_VERSION__} · Mises à jour automatiques PWA & Tauri.
              <br />
              Toutes vos données restent exclusivement sur cet appareil.
            </p>
          </div>
        </div>
        <div className="credits-bottom">
          <span>Fait pour les passionnés de musique et d'instruments à vent 🎶</span>
        </div>
      </footer>
    </main>
  );
}
