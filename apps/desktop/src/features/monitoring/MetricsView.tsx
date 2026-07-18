import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@bindings";
import { Badge, Button, EmptyState, Panel, SectionLabel } from "../../components/ui";

const DEFAULT_URL = "http://127.0.0.1:8222";

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
  const [url, setUrl] = useState(DEFAULT_URL);
  const prev = useRef<Sample | null>(null);
  const [rates, setRates] = useState<Rates | null>(null);

  const varz = useQuery({
    queryKey: ["monitor", "varz", url],
    queryFn: () => ipc.monitor.varz({ baseUrl: url }),
    refetchInterval: 2000,
  });

  // Compute per-refresh rates from the delta against the previous sample.
  const data = varz.data;
  useEffect(() => {
    if (!data) return;
    const now = Date.now();
    const p = prev.current;
    if (p && now > p.t) {
      const dt = (now - p.t) / 1000;
      setRates({
        inMsgs: Math.max(0, (data.inMsgs - p.inMsgs) / dt),
        outMsgs: Math.max(0, (data.outMsgs - p.outMsgs) / dt),
        inBytes: Math.max(0, (data.inBytes - p.inBytes) / dt),
        outBytes: Math.max(0, (data.outBytes - p.outBytes) / dt),
      });
    }
    prev.current = {
      t: now,
      inMsgs: data.inMsgs,
      outMsgs: data.outMsgs,
      inBytes: data.inBytes,
      outBytes: data.outBytes,
    };
  }, [data]);

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <SectionLabel>Monitoring endpoint</SectionLabel>
          <input
            className="field w-80 font-mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={DEFAULT_URL}
            spellCheck={false}
          />
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
            value={fmtNum(data.inMsgs)}
            sub={rates ? `${fmtNum(Math.round(rates.inMsgs))} msg/s` : undefined}
          />
          <Stat
            label="Msgs out"
            value={fmtNum(data.outMsgs)}
            sub={rates ? `${fmtNum(Math.round(rates.outMsgs))} msg/s` : undefined}
          />
          <Stat
            label="Bytes in"
            value={fmtBytes(data.inBytes)}
            sub={rates ? `${fmtBytes(rates.inBytes)}/s` : undefined}
          />
          <Stat
            label="Bytes out"
            value={fmtBytes(data.outBytes)}
            sub={rates ? `${fmtBytes(rates.outBytes)}/s` : undefined}
          />
        </div>
      )}
    </div>
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
