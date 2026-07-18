export interface Series {
  label: string;
  values: number[];
  /** Explicit stroke color; defaults to the theme accent. */
  color?: string;
}

/**
 * Minimal themed multi-series line chart (inline SVG, no chart library).
 * Shared y-scale across series; theme-aware (accent + brand teal read in both
 * light and dark). Axis-less by design — pair with labelled legend/stats.
 */
export function LineChart({
  series,
  height = 130,
}: {
  series: Series[];
  height?: number;
}): JSX.Element {
  const W = 600;
  const H = height;
  const PAD = 6;
  const all = series.flatMap((s) => s.values);
  const lo = Math.min(0, ...all);
  const hi = Math.max(1, ...all);
  const span = hi - lo || 1;
  const n = Math.max(0, ...series.map((s) => s.values.length));

  const pointsFor = (values: number[]): string =>
    values
      .map((v, i) => {
        const x = n <= 1 ? W : (i / (n - 1)) * W;
        const y = PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full"
      style={{ height }}
      aria-hidden
    >
      {/* baseline + midline grid */}
      <line x1="0" y1={H - PAD} x2={W} y2={H - PAD} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <line x1="0" y1={H / 2} x2={W} y2={H / 2} className="stroke-border/60" strokeWidth={1} strokeDasharray="4 6" vectorEffect="non-scaling-stroke" />
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
  );
}
