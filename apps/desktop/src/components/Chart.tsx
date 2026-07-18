import { useId } from "react";

export interface Series {
  label: string;
  values: number[];
  /** Explicit stroke color; defaults to the theme accent. */
  color?: string;
}

const DEFAULT_COLOR = "rgb(var(--c-accent))";

/**
 * Themed multi-series area/line chart (inline SVG, no chart library).
 * Lines are smoothed with a Catmull-Rom→Bézier spline. Auto-fits the y-range
 * (or `zeroBased`), draws labelled gridlines, an optional gradient area fill,
 * and a live dot at the latest sample. Theme-aware.
 */
export function LineChart({
  series,
  height = 150,
  zeroBased = false,
  area = false,
  formatY = (v) => String(Math.round(v)),
}: {
  series: Series[];
  height?: number;
  zeroBased?: boolean;
  area?: boolean;
  formatY?: (v: number) => string;
}): JSX.Element {
  const gid = useId();
  const W = 600;
  const H = height;
  const PAD = 8;

  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const dataMin = all.length ? Math.min(...all) : 0;
  const dataMax = all.length ? Math.max(...all) : 1;
  let lo = zeroBased ? Math.min(0, dataMin) : dataMin;
  let hi = dataMax;
  if (hi === lo) hi = lo + Math.abs(lo || 1) * 0.5 + 1;
  const pad = (hi - lo) * (zeroBased ? 0 : 0.12);
  const plotLo = lo - pad;
  const plotHi = hi + pad;
  const plotSpan = plotHi - plotLo || 1;
  const n = Math.max(0, ...series.map((s) => s.values.length));

  const xFor = (i: number): number => (n <= 1 ? W : (i / (n - 1)) * W);
  const yFor = (v: number): number => PAD + (1 - (v - plotLo) / plotSpan) * (H - 2 * PAD);
  const clampY = (y: number): number => Math.max(PAD, Math.min(H - PAD, y));

  /** Catmull-Rom smoothed cubic path through the value points. */
  const smoothLine = (values: number[]): string => {
    const p: [number, number][] = values.map((v, i) => [xFor(i), yFor(v)]);
    if (p.length === 0) return "";
    if (p.length === 1) return `M${p[0]![0].toFixed(1)},${p[0]![1].toFixed(1)}`;
    let d = `M${p[0]![0].toFixed(1)},${p[0]![1].toFixed(1)}`;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i === 0 ? 0 : i - 1]!;
      const p1 = p[i]!;
      const p2 = p[i + 1]!;
      const p3 = p[Math.min(i + 2, p.length - 1)]!;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = clampY(p1[1] + (p2[1] - p0[1]) / 6);
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = clampY(p2[1] - (p3[1] - p1[1]) / 6);
      d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  };
  const areaPath = (values: number[]): string => {
    if (values.length < 2) return "";
    return `${smoothLine(values)} L${xFor(values.length - 1).toFixed(1)},${H - PAD} L${xFor(0).toFixed(1)},${H - PAD} Z`;
  };

  const ticks = [0, 1, 2, 3].map((k) => plotHi - (plotSpan * k) / 3);

  return (
    <div className="relative" style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full" aria-hidden>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={i} id={`${gid}-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color ?? DEFAULT_COLOR} stopOpacity={0.28} />
              <stop offset="100%" stopColor={s.color ?? DEFAULT_COLOR} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((_, k) => {
          const y = PAD + ((H - 2 * PAD) * k) / 3;
          return <line key={k} x1="0" y1={y} x2={W} y2={y} className="stroke-border" strokeWidth={1} opacity={k === 3 ? 1 : 0.45} vectorEffect="non-scaling-stroke" />;
        })}
        {area &&
          series.map((s, i) => (s.values.length > 1 ? <path key={`a${i}`} d={areaPath(s.values)} fill={`url(#${gid}-${i})`} /> : null))}
        {series.map((s, i) =>
          s.values.length > 0 ? (
            <path
              key={`l${i}`}
              d={smoothLine(s.values)}
              fill="none"
              stroke={s.color ?? DEFAULT_COLOR}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null,
        )}
      </svg>

      {all.length > 0 &&
        ticks.map((t, k) => (
          <span
            key={k}
            className="pointer-events-none absolute left-1 -translate-y-1/2 rounded bg-surface/70 px-1 text-[10px] tabular-nums text-faint"
            style={{ top: `${((PAD + ((H - 2 * PAD) * k) / 3) / H) * 100}%` }}
          >
            {formatY(t)}
          </span>
        ))}

      {all.length > 0 &&
        series.map((s, i) => {
          const last = s.values.at(-1);
          if (last == null) return null;
          return (
            <span key={`d${i}`} className="pointer-events-none absolute -translate-y-1/2" style={{ right: 4, top: `${(yFor(last) / H) * 100}%` }}>
              <span className="block h-2 w-2 rounded-full ring-2 ring-surface" style={{ background: s.color ?? DEFAULT_COLOR }} />
            </span>
          );
        })}
    </div>
  );
}
