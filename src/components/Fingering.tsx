import { fingeringFor, type Key } from "../lib/fingering";

/** Flûte entière, embouchure à gauche (vue du flûtiste) : tête, corps (main gauche, main droite), patte. */
const TUBE_Y = 36;
const HOLES: { key: Key; x: number; y: number; r: number; label: string }[] = [
  { key: "LT", x: 126, y: 66, r: 7, label: "pouce" },
  { key: "L1", x: 156, y: TUBE_Y, r: 10, label: "" },
  { key: "L2", x: 182, y: TUBE_Y, r: 10, label: "" },
  { key: "L3", x: 208, y: TUBE_Y, r: 10, label: "" },
  { key: "Gis", x: 230, y: 62, r: 6, label: "sol♯" },
  { key: "R1", x: 256, y: TUBE_Y, r: 10, label: "" },
  { key: "R2", x: 282, y: TUBE_Y, r: 10, label: "" },
  { key: "R3", x: 308, y: TUBE_Y, r: 10, label: "" },
  { key: "Eb", x: 330, y: 62, r: 6, label: "mi♭" },
  { key: "Cis", x: 352, y: TUBE_Y, r: 6, label: "do♯" },
  { key: "C", x: 374, y: TUBE_Y, r: 6, label: "do" },
];

export function Fingering({ midi }: { midi: number | null }) {
  const keys = midi === null ? null : fingeringFor(midi);
  return (
    <figure className="fingering" aria-label="Doigté">
      <svg viewBox="0 0 400 100" role="img">
        <text x="182" y="12" className="hand">main gauche</text>
        <text x="282" y="12" className="hand">main droite</text>
        <rect x="6" y={TUBE_Y - 13} width="388" height="26" rx="13" className="body" />
        <rect x="2" y={TUBE_Y - 10} width="8" height="20" rx="3" className="crown" />
        <ellipse cx="52" cy={TUBE_Y} rx="11" ry="7" className="embouchure" />
        <text x="52" y={TUBE_Y + 28} className="label">embouchure</text>
        <line x1="104" y1={TUBE_Y - 13} x2="104" y2={TUBE_Y + 13} className="joint" />
        <line x1="232" y1={TUBE_Y - 13} x2="232" y2={TUBE_Y + 13} className="joint" />
        <line x1="338" y1={TUBE_Y - 13} x2="338" y2={TUBE_Y + 13} className="joint" />
        {HOLES.map((h) => (
          <g key={h.key}>
            <circle cx={h.x} cy={h.y} r={h.r} className={keys?.includes(h.key) ? "closed" : "open"} />
            {h.label && (
              <text x={h.x} y={h.y + h.r + 12} className="label">
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
