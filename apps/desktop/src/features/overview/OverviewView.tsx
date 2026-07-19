import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ConnectionStatus, ipc, type VarzDto } from "@bindings";
import { useActiveConnection } from "../../lib/activeConnection";
import { useMonitorUrl } from "../../lib/monitorUrl";
import { useUiStore } from "../../lib/uiStore";
import { Badge, Button, EmptyState, Panel, SearchInput, SectionLabel, StatusDot, statusMeta } from "../../components/ui";
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
  const { active } = useActiveConnection();
  const setView = useUiStore((s) => s.setView);
  const info = active?.serverInfo;
  const connected = active?.status === ConnectionStatus.Connected;
  const meta = statusMeta(active?.status ?? ConnectionStatus.Disconnected);

  const { url, setUrl } = useMonitorUrl();
  const [q, setQ] = useState("");
  const [rtt, setRtt] = useState<number[]>([]);
  const prevVarz = useRef<{ t: number; inBytes: number; outBytes: number } | null>(null);
  const [proc, setProc] = useState<{ rate: number; history: number[] }>({ rate: 0, history: [] });

  // Poll streams so "Data stored" / "Streams" reflect publishes & new streams.
  const streams = useQuery({ queryKey: ["streams", connId], queryFn: () => ipc.jetstream.listStreams({ connectionId: connId }), refetchInterval: 3000 });
  const varz = useQuery({ queryKey: ["monitor", "varz", url], queryFn: () => ipc.monitor.varz({ baseUrl: url }), refetchInterval: 1000 });
  const connz = useQuery({ queryKey: ["monitor", "connz", url], queryFn: () => ipc.monitor.connz({ baseUrl: url }), refetchInterval: 3000 });
  const v: VarzDto | undefined = varz.data;

  // Live RTT (µs).
  useEffect(() => {
    setRtt([]);
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
  }, [connId]);

  // Data-processed rate (bytes/sec in+out) from varz deltas.
  useEffect(() => {
    if (!v) return;
    const now = Date.now();
    const p = prevVarz.current;
    if (p && now > p.t) {
      const dt = (now - p.t) / 1000;
      const rate = Math.max(0, (v.inBytes - p.inBytes + (v.outBytes - p.outBytes)) / dt);
      setProc((s) => ({ rate, history: [...s.history, rate].slice(-48) }));
    }
    prevVarz.current = { t: now, inBytes: v.inBytes, outBytes: v.outBytes };
  }, [v]);

  const items = streams.data?.streams ?? [];
  const needle = q.trim().toLowerCase();
  const filtered =
    needle === ""
      ? items
      : items.filter((s) => s.config.name.toLowerCase().includes(needle) || s.config.subjects.some((subj) => subj.toLowerCase().includes(needle)));
  const conns = connz.data?.connections ?? [];

  const totalStored = items.reduce((a, s) => a + s.state.bytes, 0);
  const totalMsgs = items.reduce((a, s) => a + s.state.messages, 0);
  const topStreams = [...items].sort((a, b) => b.state.bytes - a.state.bytes).slice(0, 6);
  const maxStreamBytes = Math.max(1, ...topStreams.map((s) => s.state.bytes));

  const checks: { label: string; tone: "positive" | "warning" | "danger"; icon: string }[] = [
    connected ? { label: "Connected", tone: "positive", icon: "check" } : { label: meta.label, tone: "danger", icon: "x" },
    info?.jetstream ? { label: "JetStream", tone: "positive", icon: "check" } : { label: "No JetStream", tone: "warning", icon: "alert" },
    varz.isError ? { label: "Monitoring off", tone: "warning", icon: "alert" } : { label: "Monitoring", tone: "positive", icon: "check" },
    v && v.slowConsumers > 0 ? { label: `${v.slowConsumers} slow`, tone: "warning", icon: "alert" } : { label: "No slow consumers", tone: "positive", icon: "check" },
  ];

  return (
    <div className="mx-auto h-full max-w-6xl space-y-5 overflow-auto p-5">
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
          <div className="flex flex-wrap gap-1.5">
            {checks.map((c) => (
              <Badge key={c.label} tone={c.tone}>
                <Icon name={c.icon} size={12} /> {c.label}
              </Badge>
            ))}
          </div>
        </div>
        {active?.lastError && <p className="mt-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-xs text-danger">{active.lastError}</p>}
      </Panel>

      {/* Data: stored + processed */}
      <div className="grid gap-5 lg:grid-cols-2">
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
                  <span className="w-28 shrink-0 truncate text-muted" title={s.config.name}>{s.config.name}</span>
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
        </Panel>
      </div>

      {/* Stats + latency */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Subscriptions" value={v ? fmtNum(v.subscriptions) : "—"} icon="signal" />
        <Stat label="Connections" value={v ? fmtNum(v.connections) : "—"} icon="users" />
        <Stat label="Streams" value={fmtNum(items.length)} icon="database" />
        <Panel className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-muted">
              <Icon name="clock" size={15} />
              <span className="text-[11px] font-semibold uppercase tracking-wider">Round-trip</span>
            </div>
            <span className="text-lg font-semibold tabular-nums text-content">{fmtRtt(rtt.at(-1))}</span>
          </div>
          <div className="mt-2 h-16">
            {rtt.length > 1 ? (
              <LineChart series={[{ label: "rtt", values: rtt, color: ACCENT }]} height={64} formatY={fmtRtt} />
            ) : (
              <div className="flex h-full items-center text-[11px] text-faint">sampling…</div>
            )}
          </div>
        </Panel>
      </div>

      {/* Streams ↔ subjects */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <SectionLabel>
            Streams & subjects ({filtered.length}
            {needle && ` / ${items.length}`})
          </SectionLabel>
          <Button size="sm" variant="outline" icon="replay" onClick={() => void streams.refetch()} disabled={streams.isFetching}>
            {streams.isFetching ? "…" : "Refresh"}
          </Button>
        </div>
        {items.length > 0 && (
          <div className="mb-2">
            <SearchInput value={q} onChange={setQ} placeholder="Search stream or subject…" />
          </div>
        )}
        {items.length === 0 ? (
          <Panel className="p-6 text-center text-xs text-muted">No JetStream streams on this server yet.</Panel>
        ) : filtered.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted">No matches for “{q}”.</p>
        ) : (
          <div className="space-y-2">
            {filtered.map((s) => (
              <Panel key={s.config.name} className="p-3">
                <div className="flex items-center justify-between gap-3">
                  <button type="button" onClick={() => setView("browser")} className="truncate text-sm font-medium text-content hover:text-accent" title="Open in Message Browser">
                    {s.config.name}
                  </button>
                  <div className="flex shrink-0 items-center gap-3 text-xs text-muted">
                    <span className="tabular-nums">{fmtNum(s.state.messages)} msgs</span>
                    <span className="tabular-nums">{fmtBytes(s.state.bytes)}</span>
                    <span className="tabular-nums">{fmtNum(s.state.consumerCount)} consumers</span>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.config.subjects.length === 0 ? (
                    <span className="text-xs text-faint">(no subjects)</span>
                  ) : (
                    s.config.subjects.map((subj) => (
                      <span key={subj} className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-content">
                        {subj}
                      </span>
                    ))
                  )}
                </div>
              </Panel>
            ))}
          </div>
        )}
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

      <div className="flex items-center gap-2 pb-2">
        <span className="text-[11px] text-faint">Monitoring</span>
        <input className="field h-8 max-w-xs font-mono text-xs" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
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
