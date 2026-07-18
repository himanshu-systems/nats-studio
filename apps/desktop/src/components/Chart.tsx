export interface Series {
  label: string;
  values: number[];
  /** Explicit stroke color; defaults to the theme accent. */
  color?: string;
}

/**
 * Minimal themed multi-series line chart (inline SVG, no chart library).
 * Auto-fits the y-range to the data (with padding) so small bands like
 * sub-millisecond latency read clearly; pass `zeroBased` for rate charts that
 * should anchor at 0. `formatY` renders faint min/max scale labels.
 * Theme-aware (accent + brand teal work in light and dark).
 */
export function LineChart({
  series,
  height = 130,
  zeroBased = false,
  formatY,
}: {
  series: Series[];
  height?: number;
  zeroBased?: boolean;
  formatY?: (v: number) => string;
}): JSX.Element {
  const W = 600;
  const H = height;
  const PAD = 6;

  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const dataMin = all.length ? Math.min(...all) : 0;
  const dataMax = all.length ? Math.max(...all) : 1;
  let lo = zeroBased ? Math.min(0, dataMin) : dataMin;
  let hi = dataMax;
  if (hi === lo) {
    // Flat data → give it a band so the line sits centered, not glued to an edge.
    hi = lo + Math.abs(lo || 1) * 0.5 + 1;
  }
  const span = hi - lo;
  const padFrac = zeroBased ? 0 : 0.12;
  const plotLo = lo - span * padFrac;
  const plotHi = hi + span * padFrac;
  const plotSpan = plotHi - plotLo || 1;
  const n = Math.max(0, ...series.map((s) => s.values.length));

  const pointsFor = (values: number[]): string =>
    values
      .map((v, i) => {
        const x = n <= 1 ? W : (i / (n - 1)) * W;
        const y = PAD + (1 - (v - plotLo) / plotSpan) * (H - 2 * PAD);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  return (
    <div className="relative" style={{ height }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        aria-hidden
      >
        <line x1="0" y1={H - PAD} x2={W} y2={H - PAD} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <line x1="0" y1={H / 2} x2={W} y2={H / 2} className="stroke-border" strokeWidth={1} strokeDasharray="4 6" opacity={0.5} vectorEffect="non-scaling-stroke" />
        {series.map((s) =>
          s.values.length > 0 ? (
            <polyline
              key={s.label}
              points={pointsFor(s.values)}
              fill="none"
              stroke={s.color ?? "rgb(var(--c-accent))"}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null,
        )}
      </svg>
      {formatY && all.length > 0 && (
        <>
          <span className="pointer-events-none absolute right-1 top-0 rounded bg-surface/70 px-1 text-[10px] tabular-nums text-faint">
            {formatY(hi)}
          </span>
          <span className="pointer-events-none absolute bottom-0 right-1 rounded bg-surface/70 px-1 text-[10px] tabular-nums text-faint">
            {formatY(lo)}
          </span>
        </>
      )}
    </div>
  );
}
