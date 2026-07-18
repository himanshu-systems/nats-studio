import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@bindings";
import { useActiveConnection } from "../../lib/activeConnection";
import { Badge, Button, EmptyState, Panel, SearchInput, SectionLabel } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { RequireConnection } from "../../components/RequireConnection";

const DEFAULT_URL = "http://127.0.0.1:8222";
const fmtNum = (n: number): string => n.toLocaleString();

/** Topology: streams↔subjects, the server everything flows through, and clients. */
export function TopologyView(): JSX.Element {
  return <RequireConnection>{(connId) => <Topology connId={connId} />}</RequireConnection>;
}

function Topology({ connId }: { connId: string }): JSX.Element {
  const { active } = useActiveConnection();
  const info = active?.serverInfo;
  const [url, setUrl] = useState(DEFAULT_URL);
  const [q, setQ] = useState("");

  const streams = useQuery({
    queryKey: ["streams", connId],
    queryFn: () => ipc.jetstream.listStreams({ connectionId: connId }),
  });
  const varz = useQuery({
    queryKey: ["monitor", "varz", url],
    queryFn: () => ipc.monitor.varz({ baseUrl: url }),
    refetchInterval: 3000,
  });
  const connz = useQuery({
    queryKey: ["monitor", "connz", url],
    queryFn: () => ipc.monitor.connz({ baseUrl: url }),
    refetchInterval: 3000,
  });

  const items = streams.data?.streams ?? [];
  const needle = q.trim().toLowerCase();
  const filtered =
    needle === ""
      ? items
      : items.filter(
          (s) =>
            s.config.name.toLowerCase().includes(needle) ||
            s.config.subjects.some((subj) => subj.toLowerCase().includes(needle)),
        );
  const conns = connz.data?.connections ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 overflow-auto p-4">
      {/* Server: where all data flows right now */}
      <Panel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-surface-2 text-accent">
              <Icon name="server" size={22} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-content">{active?.name ?? "—"}</h2>
              <div className="mt-0.5 font-mono text-xs text-muted">
                {info ? `${info.serverName} · ${info.host}:${info.port} · v${info.version}` : "connecting…"}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 text-right">
            <HeadStat label="Subscribers" value={varz.data ? fmtNum(varz.data.subscriptions) : "—"} />
            <HeadStat label="Connections" value={varz.data ? fmtNum(varz.data.connections) : "—"} />
            <HeadStat label="Streams" value={fmtNum(items.length)} />
          </div>
        </div>
        {varz.isError && (
          <p className="mt-3 text-xs text-warning">
            Subscriber/connection counts need HTTP monitoring — start the server with
            <span className="font-mono"> -m 8222</span> (endpoint below).
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[11px] text-faint">Monitoring</span>
          <input
            className="field h-8 max-w-xs font-mono text-xs"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
          />
        </div>
      </Panel>

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
        <div className="mb-2">
          <SearchInput value={q} onChange={setQ} placeholder="Search stream or subject…" />
        </div>
        {items.length === 0 ? (
          <EmptyState icon="database" title="No streams">
            No JetStream streams on this server yet.
          </EmptyState>
        ) : filtered.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted">No matches for “{q}”.</p>
        ) : (
          <div className="space-y-2">
            {filtered.map((s) => (
              <Panel key={s.config.name} className="p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium text-content">{s.config.name}</span>
                  <div className="flex shrink-0 items-center gap-3 text-xs text-muted">
                    <span className="tabular-nums">{fmtNum(s.state.messages)} msgs</span>
                    <span className="tabular-nums">{fmtNum(s.state.consumerCount)} consumers</span>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.config.subjects.length === 0 ? (
                    <span className="text-xs text-faint">(no subjects)</span>
                  ) : (
                    s.config.subjects.map((subj) => (
                      <span
                        key={subj}
                        className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-content"
                      >
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

      {/* Clients / subscribers on this server */}
      <div>
        <SectionLabel>Clients on this server ({conns.length})</SectionLabel>
        <Panel className="mt-2 overflow-hidden p-0">
          {conns.length === 0 ? (
            <p className="p-4 text-xs text-muted">
              {connz.isError ? "Monitoring endpoint unreachable." : "No client connections reported."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border text-muted">
                  <tr>
                    <Th>CID</Th>
                    <Th>Name</Th>
                    <Th>Address</Th>
                    <Th right>Subs</Th>
                    <Th right>In</Th>
                    <Th right>Out</Th>
                  </tr>
                </thead>
                <tbody>
                  {conns.map((c) => (
                    <tr key={c.cid} className="border-b border-border/50 last:border-0">
                      <Td mono>{c.cid}</Td>
                      <Td>{c.name || <span className="text-faint">—</span>}</Td>
                      <Td mono>
                        {c.ip}:{c.port} {c.lang ? <Badge tone="neutral">{c.lang}</Badge> : null}
                      </Td>
                      <Td right mono>{fmtNum(c.subscriptions)}</Td>
                      <Td right mono>{fmtNum(c.inMsgs)}</Td>
                      <Td right mono>{fmtNum(c.outMsgs)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function HeadStat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-content">{value}</div>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }): JSX.Element {
  return <th className={`px-3 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}
function Td({ children, right, mono }: { children: React.ReactNode; right?: boolean; mono?: boolean }): JSX.Element {
  return (
    <td className={`px-3 py-1.5 text-content ${right ? "text-right" : ""} ${mono ? "font-mono tabular-nums" : ""}`}>
      {children}
    </td>
  );
}
