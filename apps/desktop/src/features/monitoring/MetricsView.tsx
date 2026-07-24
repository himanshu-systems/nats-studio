import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@bindings";
import { Badge, Button, EmptyState, Panel, SectionLabel } from "../../components/ui";
import { LineChart } from "../../components/Chart";
import { useMonitorUrl } from "../../lib/monitorUrl";
import { useUiStore } from "../../lib/uiStore";
import { sumClientTraffic } from "../../lib/clientTraffic";

const TEAL = "#27c6a0";
const ACCENT = "rgb(var(--c-accent))";
const MAX_HISTORY = 60;

/** Format a byte count with binary units. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

const fmtNum = (n: number): string => n.toLocaleString();

interface Sample {
  t: number;
  inMsgs: number;
  outMsgs: number;
  inBytes: number;
  outBytes: number;
}
interface Rates {
  inMsgs: number;
  outMsgs: number;
  inBytes: number;
  outBytes: number;
}

export function MetricsView(): JSX.Element {
  const { url, isCustom } = useMonitorUrl();
  const currentView = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const prev = useRef<Sample | null>(null);
  const [rates, setRates] = useState<Rates | null>(null);
  const [history, setHistory] = useState<Rates[]>([]);

  // This view stays mounted in the background once visited (state
  // persistence across tabs); without this, its poll would keep running
  // forever, hitting the server every second even while looking at another
  // page entirely. Only poll while Metrics is the one actually on screen.
  const isActive = currentView === "metrics";

  const varz = useQuery({
    queryKey: ["monitor", "varz", url],
    queryFn: () => ipc.monitor.varz({ baseUrl: url }),
    refetchInterval: 1000,
    enabled: isActive,
  });
  // Per-connection breakdown, polled at the same cadence — used instead of
  // varz's server-wide totals so message/byte figures below count only
  // genuine client traffic, not route/gateway/leafnode/system chatter.
  const connz = useQuery({
    queryKey: ["monitor", "connz", url],
    queryFn: () => ipc.monitor.connz({ baseUrl: url }),
    refetchInterval: 1000,
    enabled: isActive,
  });

  const data = varz.data;
  const traffic = sumClientTraffic(connz.data);

  // Compute per-refresh rates from the delta against the previous sample.
  useEffect(() => {
    if (!connz.data) return;
    const sample = sumClientTraffic(connz.data);
    const now = Date.now();
    const p = prev.current;
    if (p && now > p.t) {
      const dt = (now - p.t) / 1000;
      const r: Rates = {
        inMsgs: Math.max(0, (sample.inMsgs - p.inMsgs) / dt),
        outMsgs: Math.max(0, (sample.outMsgs - p.outMsgs) / dt),
        inBytes: Math.max(0, (sample.inBytes - p.inBytes) / dt),
        outBytes: Math.max(0, (sample.outBytes - p.outBytes) / dt),
      };
      setRates(r);
      setHistory((h) => [...h, r].slice(-MAX_HISTORY));
    }
    prev.current = { t: now, ...sample };
  }, [connz.data]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <SectionLabel>Monitoring endpoint</SectionLabel>
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono text-content">{url}</span>
            {!isCustom && (
              <button type="button" onClick={() => setView("connections")} className="text-accent hover:underline">
                set in Connections
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <Badge tone="neutral">
              {data.serverName || "server"} · v{data.version}
            </Badge>
          )}
          <Button
            size="sm"
            variant="outline"
            icon="replay"
            onClick={() => void varz.refetch()}
            disabled={varz.isFetching}
          >
            {varz.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {varz.isError ? (
        <EmptyState icon="alert" title="Cannot reach monitoring endpoint">
          Could not read <span className="font-mono">{url}/varz</span>. Ensure the NATS server was
          started with HTTP monitoring enabled (<span className="font-mono">-m 8222</span>).
        </EmptyState>
      ) : !data ? (
        <EmptyState icon="bolt" title="Loading metrics…">
          Polling the server monitoring endpoint every 2 seconds.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Stat label="Connections" value={fmtNum(data.connections)} />
          <Stat label="Subscriptions" value={fmtNum(data.subscriptions)} />
          <Stat label="Slow consumers" value={fmtNum(data.slowConsumers)} />
          <Stat label="Uptime" value={data.uptime || "—"} />
          <Stat
            label="Msgs in"
            value={fmtNum(traffic.inMsgs)}
            sub={rates ? `${fmtNum(Math.round(rates.inMsgs))} msg/s` : undefined}
          />
          <Stat
            label="Msgs out"
            value={fmtNum(traffic.outMsgs)}
            sub={rates ? `${fmtNum(Math.round(rates.outMsgs))} msg/s` : undefined}
          />
          <Stat
            label="Bytes in"
            value={fmtBytes(traffic.inBytes)}
            sub={rates ? `${fmtBytes(rates.inBytes)}/s` : undefined}
          />
          <Stat
            label="Bytes out"
            value={fmtBytes(traffic.outBytes)}
            sub={rates ? `${fmtBytes(rates.outBytes)}/s` : undefined}
          />
        </div>
      )}
      {data && (
        <p className="-mt-2 text-[11px] text-faint">
          Msgs/Bytes in/out are client traffic only — route/gateway/leafnode/system messages between nodes are excluded.
        </p>
      )}

      {data && (
        <div className="grid gap-3 lg:grid-cols-2">
          <ChartPanel
            title="Messages / sec"
            legend={[
              { label: "in", color: ACCENT, value: rates ? `${fmtNum(Math.round(rates.inMsgs))}` : "—" },
              { label: "out", color: TEAL, value: rates ? `${fmtNum(Math.round(rates.outMsgs))}` : "—" },
            ]}
            series={[
              { label: "in", values: history.map((h) => h.inMsgs), color: ACCENT },
              { label: "out", values: history.map((h) => h.outMsgs), color: TEAL },
            ]}
            formatY={(v) => fmtNum(Math.round(v))}
            empty={history.length < 2}
          />
          <ChartPanel
            title="Throughput / sec"
            legend={[
              { label: "in", color: ACCENT, value: rates ? `${fmtBytes(rates.inBytes)}` : "—" },
              { label: "out", color: TEAL, value: rates ? `${fmtBytes(rates.outBytes)}` : "—" },
            ]}
            series={[
              { label: "in", values: history.map((h) => h.inBytes), color: ACCENT },
              { label: "out", values: history.map((h) => h.outBytes), color: TEAL },
            ]}
            formatY={(v) => `${fmtBytes(v)}/s`}
            empty={history.length < 2}
          />
        </div>
      )}
    </div>
  );
}

function ChartPanel({
  title,
  legend,
  series,
  formatY,
  empty,
}: {
  title: string;
  legend: { label: string; color: string; value: string }[];
  series: { label: string; values: number[]; color: string }[];
  formatY?: (v: number) => string;
  empty: boolean;
}): JSX.Element {
  return (
    <Panel className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <SectionLabel>{title}</SectionLabel>
        <div className="flex items-center gap-3">
          {legend.map((l) => (
            <span key={l.label} className="flex items-center gap-1.5 text-xs">
              <span className="h-2 w-2 rounded-full" style={{ background: l.color }} />
              <span className="text-muted">{l.label}</span>
              <span className="tabular-nums text-content">{l.value}</span>
            </span>
          ))}
        </div>
      </div>
      {empty ? (
        <div className="flex h-[130px] items-center justify-center text-xs text-faint">
          Collecting samples…
        </div>
      ) : (
        <LineChart series={series} height={150} zeroBased area formatY={formatY} />
      )}
    </Panel>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <Panel className="p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 truncate text-2xl font-semibold tabular-nums text-content">{value}</div>
      <div className="mt-0.5 h-4 text-xs tabular-nums text-accent">{(sub as ReactNode) ?? ""}</div>
    </Panel>
  );
}
