import { useId } from "react";

/** Gráfico de líneas SVG con área degradada. `data` = array de números. */
export function LineChart({ data, width = 280, height = 80, stroke = "#5b8cff", label }) {
  const gid = useId();
  if (!data || data.length < 2) {
    return (
      <div className="flex h-20 items-center justify-center text-xs text-ink-dim" role="img" aria-label={`${label}: recopilando datos`}>
        Recopilando datos en vivo…
      </div>
    );
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = 6;
  const pts = data.map((v, i) => [
    pad + (i / (data.length - 1)) * (width - pad * 2),
    height - pad - ((v - min) / span) * (height - pad * 2),
  ]);
  const line = pts.map((p) => p.join(",")).join(" ");
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;
  const up = data[data.length - 1] >= data[0];
  const color = stroke === "auto" ? (up ? "#2ee6a8" : "#ff5c7a") : stroke;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="img"
      aria-label={`${label}: de ${data[0].toFixed(2)} a ${data[data.length - 1].toFixed(2)}, tendencia ${up ? "alcista" : "bajista"}`}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2" fill={color} />
    </svg>
  );
}

/** Donut SVG. `slices` = [{ label, value, color }]. */
export function PieChart({ slices, size = 150, totalLabel }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total <= 0) {
    return <p className="text-sm text-ink-dim">Sin gastos este mes todavía.</p>;
  }
  const R = 60;
  const C = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div className="flex items-center gap-4">
      <svg
        viewBox="0 0 150 150"
        width={size}
        height={size}
        role="img"
        aria-label={`Distribución de gastos: ${slices.map((s) => `${s.label} ${Math.round((s.value / total) * 100)} %`).join(", ")}`}
      >
        <circle cx="75" cy="75" r={R} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="18" />
        {slices.map((s) => {
          const frac = s.value / total;
          const dash = `${frac * C} ${C}`;
          const el = (
            <circle
              key={s.label}
              cx="75" cy="75" r={R}
              fill="none"
              stroke={s.color}
              strokeWidth="18"
              strokeDasharray={dash}
              strokeDashoffset={-offset * C}
              transform="rotate(-90 75 75)"
              strokeLinecap="butt"
            />
          );
          offset += frac;
          return el;
        })}
        {totalLabel && (
          <text x="75" y="80" textAnchor="middle" fill="#eaf0ff" fontSize="15" fontWeight="700">
            {totalLabel}
          </text>
        )}
      </svg>
      <ul className="space-y-1.5 text-xs" aria-hidden="true">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className="inline-block size-2.5 rounded-full" style={{ background: s.color }} />
            <span className="text-ink-dim">{s.label}</span>
            <span className="ml-auto pl-3 font-medium tabular-nums">{Math.round((s.value / total) * 100)} %</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
