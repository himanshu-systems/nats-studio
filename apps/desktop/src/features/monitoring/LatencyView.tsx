import { useEffect, useState } from "react";
import { ipc } from "@bindings";
import { Badge, EmptyState, Panel, SectionLabel } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { LineChart } from "../../components/Chart";
import { RequireConnection } from "../../components/RequireConnection";

const MAX_SAMPLES = 60;
const POLL_MS = 1000;

/** Format a round-trip time given in microseconds. */
function fmtRtt(micros: number | undefined): string {
  if (micros == null) return "—";
  if (micros < 1000) return `${Math.round(micros)} µs`;
  return `${(micros / 1000).toFixed(2)} ms`;
}

/** Live round-trip-time meter + chart for the active connection. */
export function LatencyView(): JSX.Element {
  return <RequireConnection>{(connId) => <LatencyMeter connectionId={connId} />}</RequireConnection>;
}

function LatencyMeter({ connectionId }: { connectionId: string }): JSX.Element {
  const [samples, setSamples] = useState<number[]>([]); // microseconds
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSamples([]);
    setError(null);
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const us = await ipc.connection.ping(connectionId);
        if (!alive) return;
        setError(null);
        setSamples((s) => [...s, us].slice(-MAX_SAMPLES));
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
          <span className="text-5xl font-semibold tabular-nums text-content">{fmtRtt(current)}</span>
        </div>
        <div className="mt-4">
          <LineChart series={[{ label: "rtt", values: samples }]} height={130} formatY={fmtRtt} />
        </div>
        <div className="mt-1 text-right text-[11px] text-faint">last {samples.length} samples · 1s interval</div>
      </Panel>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Min" value={fmtRtt(min)} />
        <Stat label="Avg" value={fmtRtt(avg)} />
        <Stat label="Max" value={fmtRtt(max)} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Panel className="p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-content">{value}</div>
    </Panel>
  );
}
