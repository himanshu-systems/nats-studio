import type { ReactNode } from "react";
import { ConnectionStatus } from "@bindings";
import { useActiveConnection } from "../../lib/activeConnection";
import { useUiStore } from "../../lib/uiStore";
import { Badge, Button, EmptyState, Panel, StatusDot, statusMeta } from "../../components/ui";
import { Icon } from "../../components/Icon";

/** Live at-a-glance dashboard for the active connection. */
export function OverviewView(): JSX.Element {
  const { active } = useActiveConnection();
  const setView = useUiStore((s) => s.setView);

  if (!active) {
    return (
      <EmptyState
        icon="dashboard"
        title="No connection selected"
        action={
          <Button icon="link" onClick={() => setView("connections")}>
            Go to Connections
          </Button>
        }
      >
        Connect to a NATS server and it will appear here with its server identity, JetStream status
        and latency.
      </EmptyState>
    );
  }

  const meta = statusMeta(active.status);
  const info = active.serverInfo;
  const connected = active.status === ConnectionStatus.Connected;

  return (
    <div className="mx-auto max-w-5xl space-y-4 overflow-auto p-4">
      <Panel className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-surface-2 text-accent">
              <Icon name="server" size={22} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-content">{active.name}</h2>
              <div className="mt-0.5 flex items-center gap-1.5">
                <StatusDot status={active.status} />
                <Badge tone={meta.tone}>{meta.label}</Badge>
                {connected && active.rttMs != null && (
                  <span className="text-xs text-muted">· {active.rttMs} ms RTT</span>
                )}
              </div>
            </div>
          </div>
          {connected ? (
            <Button variant="outline" icon="signal" onClick={() => setView("livetail")}>
              Live Tail
            </Button>
          ) : (
            <Button icon="link" onClick={() => setView("connections")}>
              Manage
            </Button>
          )}
        </div>
        {active.lastError && (
          <p className="mt-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-xs text-danger">
            {active.lastError}
          </p>
        )}
      </Panel>

      {info ? (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Round-trip" value={active.rttMs != null ? `${active.rttMs} ms` : "—"} icon="clock" />
            <Stat label="Max payload" value={`${Math.round(info.maxPayload / 1024)} KiB`} icon="inbox" />
            <Stat
              label="JetStream"
              value={info.jetstream ? "Enabled" : "Disabled"}
              icon="database"
              tone={info.jetstream ? "positive" : "neutral"}
            />
            <Stat label="Protocol" value={`v${info.proto}`} icon="bolt" />
          </div>

          <Panel className="p-5">
            <h3 className="mb-3 text-sm font-semibold text-content">Server</h3>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
              <Detail label="Server name" value={info.serverName} mono />
              <Detail label="Server ID" value={info.serverId} mono />
              <Detail label="Version" value={info.version} />
              <Detail label="Host" value={`${info.host}:${info.port}`} mono />
              <Detail label="Cluster" value={info.cluster ?? "—"} />
              <Detail label="Client ID" value={info.clientId != null ? String(info.clientId) : "—"} mono />
              <Detail label="Auth required" value={info.authRequired ? "Yes" : "No"} />
              <Detail label="TLS required" value={info.tlsRequired ? "Yes" : "No"} />
            </dl>
          </Panel>
        </>
      ) : (
        <Panel className="p-6">
          <p className="text-sm text-muted">
            Server details appear once the connection is established.
          </p>
        </Panel>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  icon: string;
  tone?: "neutral" | "positive";
}): JSX.Element {
  return (
    <Panel className="p-4">
      <div className="flex items-center gap-2 text-muted">
        <Icon name={icon} size={16} />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className={`mt-1.5 text-xl font-semibold tabular-nums ${tone === "positive" ? "text-positive" : "text-content"}`}>
        {value}
      </div>
    </Panel>
  );
}

function Detail({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-2">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={`truncate text-sm font-medium text-content ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
