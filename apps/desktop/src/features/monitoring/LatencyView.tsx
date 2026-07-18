import { useEffect, useState } from "react";
import { ipc } from "@bindings";
import { Badge, EmptyState, Panel, SectionLabel } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { RequireConnection } from "../../components/RequireConnection";

const MAX_SAMPLES = 60;
const POLL_MS = 1000;

/** Live round-trip-time meter + sparkline for the active connection. */
export function LatencyView(): JSX.Element {
  return <RequireConnection>{(connId) => <LatencyMeter connectionId={connId} />}</RequireConnection>;
}

function LatencyMeter({ connectionId }: { connectionId: string }): JSX.Element {
  const [samples, setSamples] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSamples([]);
    setError(null);
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const ms = await ipc.connection.ping(connectionId);
        if (!alive) return;
        setError(null);
        setSamples((s) => [...s, ms].slice(-MAX_SAMPLES));
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Ping failed");
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [connectionId]);

  const current = samples.at(-1);
  const min = samples.length ? Math.min(...samples) : undefined;
  const max = samples.length ? Math.max(...samples) : undefined;
  const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : undefined;

  if (samples.length === 0) {
    return (
      <EmptyState icon={error ? "alert" : "activity"} title={error ? "Cannot measure latency" : "Measuring latency…"}>
        {error ?? "Pinging the server every second to sample round-trip time."}
      </EmptyState>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-4 overflow-auto p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-muted">
          <Icon name="clock" size={16} />
          <SectionLabel>Round-trip time</SectionLabel>
        </div>
        {error && <Badge tone="warning">{error}</Badge>}
      </div>

      <Panel className="p-5">
        <div className="flex items-baseline gap-1.5">
          <span className="text-5xl font-semibold tabular-nums text-content">{current}</span>
          <span className="text-lg text-muted">ms</span>
        </div>
        <div className="mt-4">
          <Sparkline samples={samples} />
        </div>
      </Panel>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Min" value={min} />
        <Stat label="Avg" value={avg != null ? Math.round(avg) : undefined} />
        <Stat label="Max" value={max} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value?: number }): JSX.Element {
  return (
    <Panel className="p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-content">
        {value != null ? `${value} ms` : "—"}
      </div>
    </Panel>
  );
}

/** Hand-rolled inline-SVG sparkline over the RTT samples (no chart library). */
function Sparkline({ samples }: { samples: number[] }): JSX.Element {
  const W = 600;
  const H = 120;
  const PAD = 8;
  const lo = Math.min(...samples);
  const hi = Math.max(...samples);
  const span = hi - lo || 1;
  const n = samples.length;
  const points = samples
    .map((v, i) => {
      const x = n === 1 ? W : (i / (n - 1)) * W;
      const y = PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-32 w-full" aria-hidden>
      <polyline
        points={points}
        fill="none"
        className="stroke-accent"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
