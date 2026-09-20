import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ConnectionStatus, ipc, type VarzDto } from "@bindings";
import { useActiveConnection } from "../../lib/activeConnection";
import { useMonitorUrl } from "../../lib/monitorUrl";
import { useUiStore } from "../../lib/uiStore";
import { sumClientTraffic } from "../../lib/clientTraffic";
import { Badge, Button, EmptyState, Panel, SectionLabel, StatusDot, statusMeta } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { LineChart } from "../../components/Chart";
import { RequireConnection } from "../../components/RequireConnection";

const ACCENT = "rgb(var(--c-accent))";
const TEAL = "#27c6a0";
const fmtNum = (n: number): string => n.toLocaleString();

function fmtBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

function fmtRtt(micros: number | undefined): string {
  if (micros == null) return "—";
  return micros < 1000 ? `${Math.round(micros)} µs` : `${(micros / 1000).toFixed(2)} ms`;
}

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
        Connect to a NATS server and its identity, health, data and topology appear here.
      </EmptyState>
    );
  }
  return <RequireConnection>{(connId) => <Dashboard connId={connId} />}</RequireConnection>;
}

function Dashboard({ connId }: { connId: string }): JSX.Element {
  const { active, activeId } = useActiveConnection();
  const currentView = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const info = active?.serverInfo;
  const connected = active?.status === ConnectionStatus.Connected;
  const meta = statusMeta(active?.status ?? ConnectionStatus.Disconnected);

  // Views stay mounted in the background (state persistence across tabs), but
  // that means an always-on poll would keep hitting the server forever after
  // a single visit — showing up as phantom "traffic" in Data processed/sec
  // even with nothing actually being published. Only poll while this is the
  // instance the user is actually looking at; state (last-seen data) is kept
  // either way, and returning here refetches immediately (react-query's
  // default behavior when a query re-enables).
  const isActive = currentView === "overview" && activeId === connId;

  const { url, isCustom } = useMonitorUrl();
  const [rtt, setRtt] = useState<number[]>([]);
  const prevTraffic = useRef<{ t: number; inBytes: number; outBytes: number } | null>(null);
  const [proc, setProc] = useState<{ rate: number; history: number[] }>({ rate: 0, history: [] });

  // Poll streams so "Data stored" / "Streams" reflect publishes & new streams.
  // This is itself a JetStream API request/reply — real NATS traffic on our
  // own connection that /connz can't tell apart from application messages
  // (no subject-level breakdown). A slower interval keeps that self-generated
  // blip infrequent enough not to read as "getting messages" on the
  // Data processed/sec chart while still refreshing promptly enough to
  // reflect new publishes.
  const streams = useQuery({
    queryKey: ["streams", connId],
    queryFn: () => ipc.jetstream.listStreams({ connectionId: connId }),
    refetchInterval: 15_000,
    enabled: isActive,
  });
  const varz = useQuery({
    queryKey: ["monitor", "varz", url],
    queryFn: () => ipc.monitor.varz({ baseUrl: url }),
    refetchInterval: 1000,
    enabled: isActive,
  });
  // Polled at the same 1s cadence as varz — its per-connection breakdown is
  // what "Data processed/sec" uses to count only genuine client traffic.
  const connz = useQuery({
    queryKey: ["monitor", "connz", url],
    queryFn: () => ipc.monitor.connz({ baseUrl: url }),
    refetchInterval: 1000,
    enabled: isActive,
  });
  const v: VarzDto | undefined = varz.data;

  // Live RTT (µs) — paused while not the active view, for the same reason.
  useEffect(() => {
    if (!isActive) return;
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const us = await ipc.connection.ping(connId);
        if (alive) setRtt((s) => [...s, us].slice(-48));
      } catch {
        /* transient */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [connId, isActive]);

  // Data-processed rate (bytes/sec in+out), from client-connection deltas
  // only — excludes route/gateway/leafnode/system traffic, so this reflects
  // what applications actually produced and consumed, not server-internal
  // chatter between nodes.
  useEffect(() => {
    if (!connz.data) return;
    const traffic = sumClientTraffic(connz.data);
    const now = Date.now();
    const p = prevTraffic.current;
    if (p && now > p.t) {
      const dt = (now - p.t) / 1000;
      const rate = Math.max(0, (traffic.inBytes - p.inBytes + (traffic.outBytes - p.outBytes)) / dt);
      setProc((s) => ({ rate, history: [...s.history, rate].slice(-48) }));
    }
    prevTraffic.current = { t: now, inBytes: traffic.inBytes, outBytes: traffic.outBytes };
  }, [connz.data]);

  const items = streams.data?.streams ?? [];
  const conns = connz.data?.connections ?? [];

  const totalStored = items.reduce((a, s) => a + s.state.bytes, 0);
  const totalMsgs = items.reduce((a, s) => a + s.state.messages, 0);
  const topStreams = [...items].sort((a, b) => b.state.bytes - a.state.bytes).slice(0, 6);
  const maxStreamBytes = Math.max(1, ...topStreams.map((s) => s.state.bytes));

  const isRefreshing = streams.isFetching || varz.isFetching || connz.isFetching;
  const refetchAll = (): void => {
    void streams.refetch();
    void varz.refetch();
    void connz.refetch();
  };

  const checks: { label: string; tone: "positive" | "warning" | "danger"; icon: string }[] = [
    connected ? { label: "Connected", tone: "positive", icon: "check" } : { label: meta.label, tone: "danger", icon: "x" },
    info?.jetstream ? { label: "JetStream", tone: "positive", icon: "check" } : { label: "No JetStream", tone: "warning", icon: "alert" },
    varz.isError ? { label: "Monitoring off", tone: "warning", icon: "alert" } : { label: "Monitoring", tone: "positive", icon: "check" },
    v && v.slowConsumers > 0 ? { label: `${v.slowConsumers} slow`, tone: "warning", icon: "alert" } : { label: "No slow consumers", tone: "positive", icon: "check" },
  ];

  return (
    <div className="h-full space-y-5 overflow-auto p-5">
      {/* Server + health */}
      <Panel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-surface-2 text-accent">
              <Icon name="server" size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-content">{active?.name}</h2>
                <StatusDot status={active?.status ?? ConnectionStatus.Disconnected} />
                <Badge tone={meta.tone}>{meta.label}</Badge>
              </div>
              <div className="mt-0.5 font-mono text-xs text-muted">
                {info ? `${info.serverName} · ${info.host}:${info.port} · v${info.version}` : "connecting…"}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1.5">
              {checks.map((c) => (
                <Badge key={c.label} tone={c.tone}>
                  <Icon name={c.icon} size={12} /> {c.label}
                </Badge>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              icon="replay"
              iconClassName={isRefreshing ? "animate-spin" : undefined}
              onClick={refetchAll}
              disabled={isRefreshing}
            >
              {isRefreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </div>
        {active?.lastError && <p className="mt-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-xs text-danger">{active.lastError}</p>}
      </Panel>

      {/* Data stored, data processed, and round-trip — three equal, full-size panels */}
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel className="p-4">
          <div className="flex items-baseline justify-between">
            <SectionLabel>Data stored (JetStream)</SectionLabel>
            <div className="text-right">
              <div className="text-2xl font-semibold tabular-nums text-content">{fmtBytes(totalStored)}</div>
              <div className="text-[11px] text-muted">{fmtNum(totalMsgs)} messages</div>
            </div>
          </div>
          <div className="mt-3 space-y-1.5">
            {topStreams.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted">No streams — nothing stored yet.</p>
            ) : (
              topStreams.map((s) => (
                <div key={s.config.name} className="flex items-center gap-2 text-xs">
                  <span className="w-20 shrink-0 truncate text-muted" title={s.config.name}>{s.config.name}</span>
                  <div className="h-3 flex-1 overflow-hidden rounded bg-surface-2">
                    <div className="h-full rounded bg-accent/70" style={{ width: `${(s.state.bytes / maxStreamBytes) * 100}%` }} />
                  </div>
                  <span className="w-16 shrink-0 text-right tabular-nums text-content">{fmtBytes(s.state.bytes)}</span>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel className="p-4">
          <div className="flex items-baseline justify-between">
            <SectionLabel>Data processed / sec</SectionLabel>
            <div className="text-2xl font-semibold tabular-nums text-content">{fmtBytes(proc.rate)}/s</div>
          </div>
          <div className="mt-3 h-[120px]">
            {proc.history.length > 1 ? (
              <LineChart series={[{ label: "bytes/s", values: proc.history, color: TEAL }]} height={120} zeroBased area formatY={(b) => `${fmtBytes(b)}/s`} />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-faint">collecting samples…</div>
            )}
          </div>
          <p className="mt-2 text-[11px] text-faint">Client traffic only — excludes route/gateway/leafnode/system messages between nodes.</p>
        </Panel>

        <Panel className="p-4">
          <div className="flex items-baseline justify-between">
            <SectionLabel>Round-trip</SectionLabel>
            <div className="text-2xl font-semibold tabular-nums text-content">{fmtRtt(rtt.at(-1))}</div>
          </div>
          <div className="mt-3 h-[120px]">
            {rtt.length > 1 ? (
              <LineChart series={[{ label: "rtt", values: rtt, color: ACCENT }]} height={120} formatY={fmtRtt} />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-faint">sampling…</div>
            )}
          </div>
        </Panel>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Subscriptions" value={v ? fmtNum(v.subscriptions) : "—"} icon="signal" />
        <Stat label="Connections" value={v ? fmtNum(v.connections) : "—"} icon="users" />
        <Stat label="Streams" value={fmtNum(items.length)} icon="database" />
      </div>

      {/* Clients */}
      <div>
        <SectionLabel>Clients on this server ({conns.length})</SectionLabel>
        <Panel className="mt-2 overflow-hidden p-0">
          {conns.length === 0 ? (
            <p className="p-4 text-xs text-muted">{varz.isError ? "Monitoring endpoint unreachable — start the server with -m 8222." : "No client connections reported."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border bg-surface-2/50 text-muted">
                  <tr>
                    <Th>CID</Th>
                    <Th>Name</Th>
                    <Th>Address</Th>
                    <Th>Lang</Th>
                    <Th right>Subs</Th>
                    <Th right>Msgs in</Th>
                    <Th right>Msgs out</Th>
                    <Th right>Bytes in</Th>
                    <Th right>Bytes out</Th>
                    <Th right>Uptime</Th>
                  </tr>
                </thead>
                <tbody>
                  {conns.map((c) => (
                    <tr key={c.cid} className="border-b border-border/40 last:border-0 hover:bg-surface-2/40">
                      <Td mono>{c.cid}</Td>
                      <Td>{c.name || <span className="text-faint">—</span>}</Td>
                      <Td mono>{c.ip}:{c.port}</Td>
                      <Td>{c.lang ? `${c.lang}${c.version ? ` ${c.version}` : ""}` : <span className="text-faint">—</span>}</Td>
                      <Td right mono>{fmtNum(c.subscriptions)}</Td>
                      <Td right mono>{fmtNum(c.inMsgs)}</Td>
                      <Td right mono>{fmtNum(c.outMsgs)}</Td>
                      <Td right mono>{fmtBytes(c.inBytes)}</Td>
                      <Td right mono>{fmtBytes(c.outBytes)}</Td>
                      <Td right mono>{c.uptime}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div className="flex items-center gap-2 pb-2 text-[11px] text-faint">
        <span>Monitoring</span>
        <span className="font-mono text-muted">{url}</span>
        {!isCustom && (
          <button type="button" onClick={() => setView("connections")} className="text-accent hover:underline">
            set in Connections
          </button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon: string }): JSX.Element {
  return (
    <Panel className="p-4">
      <div className="flex items-center gap-2 text-muted">
        <Icon name={icon} size={15} />
        <span className="text-[11px] font-semibold uppercase tracking-wider">{label}</span>
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-content">{value}</div>
    </Panel>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }): JSX.Element {
  return <th className={`whitespace-nowrap px-3 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}
function Td({ children, right, mono }: { children: React.ReactNode; right?: boolean; mono?: boolean }): JSX.Element {
  return <td className={`whitespace-nowrap px-3 py-1.5 text-content ${right ? "text-right" : ""} ${mono ? "font-mono tabular-nums" : ""}`}>{children}</td>;
}
