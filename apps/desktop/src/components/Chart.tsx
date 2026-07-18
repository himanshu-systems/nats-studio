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
 * Auto-fits the y-range (or `zeroBased`), draws labelled gridlines, an optional
 * gradient area fill, and a live dot at the latest sample. Theme-aware.
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
  const lineOf = (vals: number[]): string => vals.map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(" ");
  const areaOf = (vals: number[]): string =>
    `M0,${H - PAD} L${vals.map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(" L")} L${W},${H - PAD} Z`;

  // Four gridline levels across the padded range (top → bottom).
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
          series.map((s, i) =>
            s.values.length > 1 ? <path key={`a${i}`} d={areaOf(s.values)} fill={`url(#${gid}-${i})`} /> : null,
          )}
        {series.map((s, i) =>
          s.values.length > 0 ? (
            <polyline
              key={`l${i}`}
              points={lineOf(s.values)}
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

      {/* y-axis tick labels (HTML so they aren't distorted by the stretched SVG) */}
      {all.length > 0 &&
        ticks.map((t, k) => (
          <span
            key={k}
            className="pointer-events-none absolute left-1 -translate-y-1/2 rounded bg-surface/70 px-1 text-[10px] tabular-nums text-faint"
            style={{ top: `${(PAD + ((H - 2 * PAD) * k) / 3) / H * 100}%` }}
          >
            {formatY(t)}
          </span>
        ))}

      {/* live dot + value for each series' latest sample */}
      {all.length > 0 &&
        series.map((s, i) => {
          const last = s.values.at(-1);
          if (last == null) return null;
          const topPct = (yFor(last) / H) * 100;
          return (
            <span
              key={`d${i}`}
              className="pointer-events-none absolute -translate-y-1/2"
              style={{ right: 4, top: `${topPct}%` }}
            >
              <span className="block h-2 w-2 rounded-full ring-2 ring-surface" style={{ background: s.color ?? DEFAULT_COLOR }} />
            </span>
          );
        })}
    </div>
  );
}
