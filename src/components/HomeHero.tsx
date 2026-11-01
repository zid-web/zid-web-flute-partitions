import { useState } from "react";

interface Props {
  totalStars: number;
  totalScores: number;
  userScoreCount: number;
  pianoCount: number;
  duoCount: number;
  isExplorerOpen: boolean;
  onToggleExplorer: () => void;
  onExploreScores: () => void;
  onMyFlute: () => void;
  onOpenImport: () => void;
}

export function HomeHero({
  totalStars,
  totalScores,
  userScoreCount,
  pianoCount,
  duoCount,
  isExplorerOpen,
  onToggleExplorer,
  onExploreScores,
  onMyFlute,
  onOpenImport,
}: Props) {
  const [copied, setCopied] = useState(false);

  function shareApp() {
    if (navigator.share) {
      navigator.share({
        title: "Flûte Partitions",
        text: "Application interactive d'apprentissage de la flûte traversière avec reconnaissance de notes au micro !",
        url: window.location.href,
      }).catch(() => {});
    } else {
      navigator.clipboard.writeText(window.location.href).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }).catch(() => {});
    }
  }

  return (
    <section className="hero-banner" aria-label="Présentation de l'application">
      <div className="hero-glow" aria-hidden="true" />
      <div className="hero-content">
        <div className="hero-badge-wrap">
          <span className="hero-pill">
            <span className="live-dot" aria-hidden="true" /> Studio Interactif de Flûte
          </span>
          <span className="hero-pill secondary">
            📶 100% Hors-ligne & Libre
          </span>
        </div>

        <h1 className="hero-title">
          Apprenez & jouez la <span className="gradient-text">flûte traversière</span> en direct
        </h1>

        <p className="hero-lead">
          Jouez avec votre propre flûte devant le micro : chaque note s'allume instantanément quand vous la réussissez.
          Profitez d'un accompagnement piano réactif à votre tempo, de doigtés dynamiques et de partitions du domaine public.
        </p>

        <div className="hero-actions">
          <button className="primary hero-btn main-cta" onClick={onExploreScores}>
            🚀 Explorer les partitions
          </button>
          <button
            className={`hero-btn ${isExplorerOpen ? "active" : ""}`}
            onClick={onToggleExplorer}
            title="Tester le son des notes et voir les doigtés de flûte"
          >
            🎵 {isExplorerOpen ? "Masquer l'accordeur" : "Accordeur & Doigtés"}
          </button>
          <button
            className="hero-btn ghost-light"
            onClick={onMyFlute}
            title="Enregistrer le son unique de votre flûte"
          >
            🎙️ Ma flûte
          </button>
          <button
            className="hero-btn ghost-light"
            onClick={onOpenImport}
            title="Importer une partition MusicXML ou PDF"
          >
            📥 Importer (.mxl / .pdf)
          </button>
        </div>

        <div className="hero-stats-bar">
          <div className="hero-stat-item" title="Nombre total de partitions disponibles">
            <span className="stat-number">{totalScores}</span>
            <span className="stat-label">Partitions</span>
          </div>
          <div className="hero-stat-sep" aria-hidden="true" />
          <div className="hero-stat-item" title="Étoiles cumulées lors de vos sessions">
            <span className="stat-number star-color">⭐ {totalStars}</span>
            <span className="stat-label">Étoiles gagnées</span>
          </div>
          <div className="hero-stat-sep" aria-hidden="true" />
          <div className="hero-stat-item" title="Partitions avec accompagnement piano interactif">
            <span className="stat-number">🎹 {pianoCount}</span>
            <span className="stat-label">Avec piano</span>
          </div>
          <div className="hero-stat-sep" aria-hidden="true" />
          <div className="hero-stat-item" title="Morceaux en duo de flûtes">
            <span className="stat-number">🎶 {duoCount}</span>
            <span className="stat-label">Duos</span>
          </div>
          {userScoreCount > 0 && (
            <>
              <div className="hero-stat-sep" aria-hidden="true" />
              <div className="hero-stat-item" title="Partitions personnelles importées sur cet appareil">
                <span className="stat-number">📂 {userScoreCount}</span>
                <span className="stat-label">Mes imports</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="hero-visual" aria-hidden="true">
        <div className="hero-card-preview">
          <div className="preview-header">
            <span className="preview-dot red" />
            <span className="preview-dot yellow" />
            <span className="preview-dot green" />
            <span className="preview-title">Aperçu interactif</span>
          </div>
          <div className="preview-body">
            <div className="preview-note-live">
              <span className="note-name">Sol₄</span>
              <span className="note-tag good">Note réussie ✓</span>
            </div>
            <div className="preview-staff">
              <span className="staff-line" />
              <span className="staff-line" />
              <span className="staff-line" />
              <span className="staff-line" />
              <span className="staff-line" />
              <span className="animated-note orange" style={{ left: "25%" }}>♩</span>
              <span className="animated-note green" style={{ left: "55%" }}>♪</span>
              <span className="animated-note gold" style={{ left: "80%" }}>♫</span>
            </div>
            <div className="preview-info">
              <span>🎤 Micro actif</span>
              <span>🎹 Piano en tempo</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
