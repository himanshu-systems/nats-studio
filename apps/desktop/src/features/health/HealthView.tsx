import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ConnectionStatus, ipc } from "@bindings";
import { useActiveConnection } from "../../lib/activeConnection";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, Panel, SectionLabel, cx } from "../../components/ui";
import { Icon } from "../../components/Icon";

const DEFAULT_MONITOR_URL = "http://127.0.0.1:8222";

type Severity = "pass" | "warn" | "fail";

interface Check {
  label: string;
  severity: Severity;
  detail: string;
}

/** Visuals per check severity (chip color + icon). */
const SEV: Record<Severity, { icon: string; chip: string }> = {
  pass: { icon: "check", chip: "bg-positive/10 text-positive" },
  warn: { icon: "alert", chip: "bg-warning/10 text-warning" },
  fail: { icon: "x", chip: "bg-danger/10 text-danger" },
};

/** Overall banner derived from the worst check severity. */
const BANNER: Record<Severity, { label: string; tone: "positive" | "warning" | "danger" }> = {
  pass: { label: "Healthy", tone: "positive" },
  warn: { label: "Degraded", tone: "warning" },
  fail: { label: "Unhealthy", tone: "danger" },
};

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Client-computed health dashboard composing existing connection / JetStream / monitoring APIs. */
export function HealthView(): JSX.Element {
  return <RequireConnection>{(connId) => <Health connId={connId} />}</RequireConnection>;
}

function Health({ connId }: { connId: string }): JSX.Element {
  const { active } = useActiveConnection();
  const [monitorUrl, setMonitorUrl] = useState(DEFAULT_MONITOR_URL);

  const streams = useQuery({
    queryKey: ["health", "streams", connId],
    queryFn: () => ipc.jetstream.listStreams({ connectionId: connId }),
    refetchInterval: 4000,
  });

  // Monitoring is best-effort: a failure surfaces as a "reachable?" warning, never a crash.
  const monitor = useQuery({
    queryKey: ["health", "monitor", monitorUrl],
    queryFn: async () => {
      const [varz, connz] = await Promise.all([
        ipc.monitor.varz({ baseUrl: monitorUrl }),
        ipc.monitor.connz({ baseUrl: monitorUrl }),
      ]);
      return { varz, connz };
    },
    refetchInterval: 4000,
    retry: false,
  });

  if (!active) {
    return (
      <EmptyState icon="link" title="No active connection">
        Reconnect to a NATS server to compute its health.
      </EmptyState>
    );
  }

  const connected = active.status === ConnectionStatus.Connected;
  const jetstream = active.serverInfo?.jetstream ?? false;
  const streamList = streams.data?.streams ?? [];
  const streamCount = streamList.length;
  const consumerCount = streamList.reduce((n, s) => n + s.state.consumerCount, 0);
  const varz = monitor.data?.varz;
  const connz = monitor.data?.connz;

  const checks: Check[] = [
    {
      label: "Connection",
      severity: connected ? "pass" : "fail",
      detail: connected
        ? `Connected to ${active.serverInfo?.serverName ?? active.name}`
        : "Not connected",
    },
  ];

  if (active.rttMs != null) {
    const rtt = active.rttMs;
    checks.push({
      label: "Round-trip latency",
      severity: rtt < 250 ? "pass" : rtt < 1000 ? "warn" : "fail",
      detail: `${rtt} ms`,
    });
  }

  checks.push({
    label: "JetStream",
    severity: jetstream ? "pass" : "warn",
    detail: jetstream ? "Enabled" : "Not enabled on this server",
  });

  checks.push({
    label: "Streams",
    severity: streamCount > 0 ? "pass" : "warn",
    detail:
      streamCount > 0
        ? `${plural(streamCount, "stream")}, ${plural(consumerCount, "consumer")}`
        : "No streams defined",
  });

  checks.push({
    label: "Monitoring endpoint",
    severity: varz ? "pass" : "warn",
    detail: varz
      ? `Reachable at ${monitorUrl}`
      : "Unreachable — start the server with -m 8222 for slow-consumer & connection signals",
  });

  if (varz) {
    checks.push({
      label: "Slow consumers",
      severity: varz.slowConsumers === 0 ? "pass" : "warn",
      detail: varz.slowConsumers === 0 ? "None" : plural(varz.slowConsumers, "slow consumer"),
    });
    checks.push({
      label: "Connection count",
      severity: "pass",
      detail: connz
        ? `${plural(varz.connections, "connection")} · ${connz.numConnections} in /connz`
        : plural(varz.connections, "connection"),
    });
  }

  const worst: Severity = checks.some((c) => c.severity === "fail")
    ? "fail"
    : checks.some((c) => c.severity === "warn")
      ? "warn"
      : "pass";
  const banner = BANNER[worst];
  const passing = checks.filter((c) => c.severity === "pass").length;

  const refreshAll = (): void => {
    void streams.refetch();
    void monitor.refetch();
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 overflow-auto p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <SectionLabel>Monitoring endpoint</SectionLabel>
          <input
            className="field w-72 font-mono"
            value={monitorUrl}
            onChange={(e) => setMonitorUrl(e.target.value)}
            placeholder={DEFAULT_MONITOR_URL}
            spellCheck={false}
          />
        </div>
        <Button
          variant="outline"
          icon="replay"
          onClick={refreshAll}
          disabled={streams.isFetching || monitor.isFetching}
        >
          {streams.isFetching || monitor.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <Panel className="p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-surface-2 text-accent">
            <Icon name="activity" size={22} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-content">System health</h2>
              <Badge tone={banner.tone}>{banner.label}</Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {passing} of {checks.length} checks passing
            </p>
          </div>
        </div>
      </Panel>

      <Panel className="p-4">
        <SectionLabel>Checks</SectionLabel>
        <ul className="mt-2">
          {checks.map((c) => {
            const sev = SEV[c.severity];
            return (
              <li
                key={c.label}
                className="flex items-start gap-3 border-b border-border/60 py-2.5 last:border-0"
              >
                <span
                  className={cx(
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                    sev.chip,
                  )}
                >
                  <Icon name={sev.icon} size={13} />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-content">{c.label}</div>
                  <div className="truncate text-xs text-muted">{c.detail}</div>
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}
