// Лёгкие SVG-графики без зависимостей: area-график, кольцевой индикатор, полоса.
import React, { useId } from 'react';
import { clamp, levelColor } from './util';

export interface Series {
  values: number[];
  color: string;
  label?: string;
}

/** Плавная кривая (кардинальный сплайн → кубические Безье). */
function smoothPath(points: [number, number][]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${points[0][0]},${points[0][1]}`;
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const t = 0.18;
    const c1x = p1[0] + (p2[0] - p0[0]) * t;
    const c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t;
    const c2y = p2[1] - (p3[1] - p1[1]) * t;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/**
 * Area-график для нескольких рядов. `capacity` — сколько точек помещается по ширине
 * (новые точки появляются справа, как в диспетчере задач).
 */
export function AreaChart({ series, height = 90, max, capacity = 60, grid = true }: {
  series: Series[];
  height?: number;
  max?: number;
  capacity?: number;
  grid?: boolean;
}) {
  const uid = useId().replace(/:/g, '');
  const width = 300;
  const top = 4;
  const usable = height - top - 2;
  const peak = max ?? Math.max(1, ...series.flatMap((s) => s.values));
  const step = width / Math.max(1, capacity - 1);

  return (
    <svg className="tx-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ height }}>
      <defs>
        {series.map((s, i) => (
          <linearGradient key={i} id={`g${uid}${i}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={s.color} stopOpacity="0.38" />
            <stop offset="100%" stopColor={s.color} stopOpacity="0.02" />
          </linearGradient>
        ))}
      </defs>
      {grid && [0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1="0" x2={width} y1={top + usable * f} y2={top + usable * f} className="tx-chart-grid" />
      ))}
      {series.map((s, i) => {
        const vals = s.values.slice(-capacity);
        const offset = capacity - vals.length;
        const pts: [number, number][] = vals.map((v, j) => [
          (offset + j) * step,
          top + usable - clamp(v / peak, 0, 1) * usable,
        ]);
        if (pts.length < 2) return null;
        const line = smoothPath(pts);
        const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
        return (
          <g key={i}>
            <path d={area} fill={`url(#g${uid}${i})`} />
            <path d={line} fill="none" stroke={s.color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </g>
        );
      })}
    </svg>
  );
}

/** Кольцевой индикатор 0–1. */
export function Ring({ value, size = 92, stroke = 9, color, children }: {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  children?: React.ReactNode;
}) {
  const v = clamp(Number.isFinite(value) ? value : 0, 0, 1);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const col = color ?? levelColor(v);
  return (
    <div className="tx-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} className="tx-ring-track" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={col}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * v} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray .5s ease, stroke .3s' }}
        />
      </svg>
      <div className="tx-ring-label">{children}</div>
    </div>
  );
}

/** Горизонтальная полоса заполнения с цветом по уровню. */
export function Meter({ value, color, thin }: { value: number; color?: string; thin?: boolean }) {
  const v = clamp(Number.isFinite(value) ? value : 0, 0, 1);
  return (
    <div className={thin ? 'tx-meter thin' : 'tx-meter'}>
      <div style={{ width: `${v * 100}%`, background: color ?? levelColor(v) }} />
    </div>
  );
}
