import { fingeringFor, type Key } from "../lib/fingering";

const HOLES: { key: Key; x: number; y: number; r: number; label: string }[] = [
  { key: "LT", x: 30, y: 50, r: 7, label: "pouce" },
  { key: "L1", x: 60, y: 24, r: 10, label: "" },
  { key: "L2", x: 86, y: 24, r: 10, label: "" },
  { key: "L3", x: 112, y: 24, r: 10, label: "" },
  { key: "Gis", x: 132, y: 44, r: 5, label: "sol♯" },
  { key: "R1", x: 160, y: 24, r: 10, label: "" },
  { key: "R2", x: 186, y: 24, r: 10, label: "" },
  { key: "R3", x: 212, y: 24, r: 10, label: "" },
  { key: "Eb", x: 234, y: 44, r: 5, label: "mi♭" },
  { key: "Cis", x: 256, y: 24, r: 5, label: "" },
  { key: "C", x: 268, y: 24, r: 5, label: "do" },
];

export function Fingering({ midi }: { midi: number | null }) {
  const keys = midi === null ? null : fingeringFor(midi);
  return (
    <figure className="fingering" aria-label="Doigté">
      <svg viewBox="0 0 290 74" role="img">
        <rect x="4" y="12" width="282" height="24" rx="12" className="body" />
        <line x1="136" y1="12" x2="136" y2="36" className="joint" />
        {HOLES.map((h) => (
          <g key={h.key}>
            <circle cx={h.x} cy={h.y} r={h.r} className={keys?.includes(h.key) ? "closed" : "open"} />
            {h.label && (
              <text x={h.x} y={h.y + h.r + 10} className="label">
                {h.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      <figcaption>
        {keys ? "● = trou bouché / clé appuyée" : midi === null ? "—" : "Doigté de 3ᵉ octave : voir votre professeur"}
      </figcaption>
    </figure>
  );
}
