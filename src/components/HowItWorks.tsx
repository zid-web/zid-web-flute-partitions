import { useState } from "react";

interface Step {
  id: number;
  icon: string;
  badge: string;
  title: string;
  desc: string;
  detail: string;
}

const STEPS: Step[] = [
  {
    id: 1,
    icon: "🎼",
    badge: "Sélection",
    title: "1. Choisissez une œuvre",
    desc: "Parcourez notre répertoire classé par niveau (1 à 5) ou importez vos propres partitions.",
    detail: "Du répertoire traditionnel français aux sonates baroques et romantiques d'IMSLP. Vous pouvez aussi glisser-déposer n'importe quel fichier MusicXML (.mxl) ou PDF numérisé.",
  },
  {
    id: 2,
    icon: "🎤",
    badge: "Acoustique",
    title: "2. Jouez devant votre micro",
    desc: "Aucun fil ni configuration requise : jouez naturellement avec votre instrument.",
    detail: "L'algorithme de pointe McLeod écoute la fréquence exacte de votre flûte traversière. Tout est traité localement sur votre processeur : 100% privé, sans connexion internet requise.",
  },
  {
    id: 3,
    icon: "💡",
    badge: "Interactif",
    title: "3. Les notes s'allument en direct",
    desc: "Suivez le curseur : la note attendue est en orange avec son doigté exact.",
    detail: "Dès que vous jouez la bonne hauteur, la note devient verte et la partition avance ! Si une note est manquée, elle clignote gentiment en rouge pour vous guider sans vous bloquer.",
  },
  {
    id: 4,
    icon: "🎹",
    badge: "Immersion",
    title: "4. Accompagnement vivant & Ma flûte",
    desc: "Jouez avec un accompagnateur piano virtuel qui écoute votre cadence.",
    detail: "Le piano anticipe et s'ajuste au tempo de vos attaques. Avec le mode « Ma flûte », enregistrez quelques notes pour que l'application s'imprègne de la vraie couleur de votre instrument.",
  },
];

export function HowItWorks() {
  const [activeStep, setActiveStep] = useState<number | null>(null);

  return (
    <section className="how-it-works-section" aria-label="Fonctionnement de l'application">
      <div className="section-header">
        <span className="section-pill">Guide Pratique</span>
        <h2>Comment fonctionne Flûte Partitions ?</h2>
        <p>Une expérience pensée pour tous les flûtistes, des premiers souffles aux virtuoses confirmés.</p>
      </div>

      <div className="steps-grid">
        {STEPS.map((s) => {
          const isSelected = activeStep === s.id;
          return (
            <div
              key={s.id}
              className={`step-card ${isSelected ? "selected" : ""}`}
              onClick={() => setActiveStep(isSelected ? null : s.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setActiveStep(isSelected ? null : s.id);
                }
              }}
              aria-expanded={isSelected}
            >
              <div className="step-icon-wrap">
                <span className="step-icon">{s.icon}</span>
                <span className="step-badge">{s.badge}</span>
              </div>
              <h3 className="step-title">{s.title}</h3>
              <p className="step-desc">{s.desc}</p>
              <div className="step-detail-expand">
                <p>{s.detail}</p>
              </div>
              <span className="step-toggle-hint">
                {isSelected ? "Moins de détails ▲" : "En savoir plus ▼"}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
