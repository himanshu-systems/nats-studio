import { Fragment, useEffect, useRef, useState } from "react";
import {
  ipc,
  PayloadEncoding,
  type SubStreamEvent,
} from "@bindings";
import { RequireConnection } from "@/components/RequireConnection";
import { Panel, Badge, Button, EmptyState, SectionLabel, cx } from "@/components/ui";
import { Icon } from "@/components/Icon";

/** How long to collect scatter-gather replies before rendering. */
const SCAN_WINDOW_MS = 1500;

// --- NATS micro protocol reply shapes (all JSON over `$SRV.*` request/reply) ---

/** `$SRV.PING` reply — one per running instance. */
interface PingReply {
  name?: string;
  id?: string;
  version?: string;
}

interface StatsEndpoint {
  name?: string;
  subject?: string;
  num_requests?: number;
  num_errors?: number;
  processing_time?: number; // cumulative nanoseconds
  average_processing_time?: number; // nanoseconds per request
  last_error?: string;
  queue_group?: string;
}
interface StatsReply {
  name?: string;
  id?: string;
  version?: string;
  endpoints?: StatsEndpoint[];
}

interface InfoEndpoint {
  name?: string;
  subject?: string;
  queue_group?: string;
  metadata?: Record<string, string>;
}
interface InfoReply {
  name?: string;
  id?: string;
  version?: string;
  description?: string;
  metadata?: Record<string, string>;
  endpoints?: InfoEndpoint[];
}

interface SchemaEndpoint {
  name?: string;
  subject?: string;
  schema?: { request?: unknown; response?: unknown };
  request_schema?: unknown;
  response_schema?: unknown;
  request?: unknown;
  response?: unknown;
}
interface SchemaReply {
  name?: string;
  id?: string;
  version?: string;
  endpoints?: SchemaEndpoint[];
}

// --- Merged view model ---

interface Instance {
  id: string;
  version: string;
}

interface EndpointRow {
  key: string;
  name: string;
  subject?: string;
  queueGroup?: string;
  metadata?: Record<string, string>;
  numRequests: number;
  numErrors: number;
  totalProcNs: number;
  avgSampleNs?: number;
  avgProcessingNs: number;
  lastError?: string;
  hasStats: boolean;
  requestSchema?: unknown;
  responseSchema?: unknown;
}

interface MergedService {
  name: string;
  versions: string[];
  description?: string;
  instances: Instance[];
  endpoints: EndpointRow[];
}
type SvcAccum = MergedService & { epMap: Map<string, EndpointRow> };

export function ServicesView(): JSX.Element {
  return <RequireConnection>{(connId) => <Services connId={connId} />}</RequireConnection>;
}

function decodeJson<T>(payloadBase64: string): T | null {
  try {
    const bin = atob(payloadBase64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

/** Format a nanosecond duration to the most sensible unit. */
function fmtNs(ns: number): string {
  if (!isFinite(ns) || ns <= 0) return "0";
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(1)} µs`;
  return `${Math.round(ns)} ns`;
}

function schemaOf(e: SchemaEndpoint, which: "request" | "response"): unknown {
  const inner = e.schema?.[which];
  if (inner !== undefined) return inner;
  return which === "request" ? (e.request_schema ?? e.request) : (e.response_schema ?? e.response);
}

/** Merge PING/STATS/INFO/SCHEMA replies into one service list keyed by name. */
function merge(
  pings: PingReply[],
  stats: StatsReply[],
  infos: InfoReply[],
  schemas: SchemaReply[],
): MergedService[] {
  const svc = new Map<string, SvcAccum>();

  const ensure = (name?: string): SvcAccum => {
    const n = name ?? "(unnamed)";
    let s = svc.get(n);
    if (!s) {
      s = { name: n, versions: [], instances: [], endpoints: [], epMap: new Map() };
      svc.set(n, s);
    }
    return s;
  };

  const addInstance = (s: SvcAccum, id?: string, version?: string): void => {
    const iid = id ?? "(no id)";
    if (!s.instances.some((i) => i.id === iid)) s.instances.push({ id: iid, version: version ?? "?" });
    if (version && !s.versions.includes(version)) s.versions.push(version);
  };

  const ep = (s: SvcAccum, name?: string, subject?: string): EndpointRow => {
    const key = name || subject || "(default)";
    let row = s.epMap.get(key);
    if (!row) {
      row = {
        key,
        name: name || subject || "(default)",
        numRequests: 0,
        numErrors: 0,
        totalProcNs: 0,
        avgProcessingNs: 0,
        hasStats: false,
      };
      s.epMap.set(key, row);
    }
    if (subject && !row.subject) row.subject = subject;
    return row;
  };

  for (const p of pings) addInstance(ensure(p.name), p.id, p.version);

  for (const st of stats) {
    const s = ensure(st.name);
    addInstance(s, st.id, st.version);
    for (const e of st.endpoints ?? []) {
      const row = ep(s, e.name, e.subject);
      row.hasStats = true;
      row.numRequests += e.num_requests ?? 0;
      row.numErrors += e.num_errors ?? 0;
      if (typeof e.processing_time === "number") row.totalProcNs += e.processing_time;
      if (typeof e.average_processing_time === "number") row.avgSampleNs = e.average_processing_time;
      if (e.queue_group && !row.queueGroup) row.queueGroup = e.queue_group;
      if (e.last_error) row.lastError = e.last_error;
    }
  }

  for (const inf of infos) {
    const s = ensure(inf.name);
    addInstance(s, inf.id, inf.version);
    if (inf.description && !s.description) s.description = inf.description;
    for (const e of inf.endpoints ?? []) {
      const row = ep(s, e.name, e.subject);
      if (e.queue_group && !row.queueGroup) row.queueGroup = e.queue_group;
      if (e.metadata && !row.metadata) row.metadata = e.metadata;
    }
  }

  for (const sc of schemas) {
    const s = ensure(sc.name);
    addInstance(s, sc.id, sc.version);
    for (const e of sc.endpoints ?? []) {
      const row = ep(s, e.name, e.subject);
      const req = schemaOf(e, "request");
      const res = schemaOf(e, "response");
      if (req !== undefined && row.requestSchema === undefined) row.requestSchema = req;
      if (res !== undefined && row.responseSchema === undefined) row.responseSchema = res;
    }
  }

  const out: MergedService[] = [];
  for (const s of svc.values()) {
    const endpoints = [...s.epMap.values()]
      .map((r) => {
        r.avgProcessingNs =
          r.numRequests > 0 && r.totalProcNs > 0 ? r.totalProcNs / r.numRequests : (r.avgSampleNs ?? 0);
        return r;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    out.push({
      name: s.name,
      versions: s.versions.length ? s.versions : ["?"],
      description: s.description,
      instances: s.instances.sort((a, b) => a.id.localeCompare(b.id)),
      endpoints,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function Services({ connId }: { connId: string }): JSX.Element {
  const [services, setServices] = useState<MergedService[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openEndpoints, setOpenEndpoints] = useState<Set<string>>(new Set());

  // Track every in-flight subscription + timer so we can tear a scan down.
  const activeRef = useRef<{ handles: string[]; timers: ReturnType<typeof setTimeout>[] }>({
    handles: [],
    timers: [],
  });

  const cleanup = (): void => {
    for (const t of activeRef.current.timers) clearTimeout(t);
    for (const id of activeRef.current.handles) void ipc.pubsub.unsubscribe(id);
    activeRef.current = { handles: [], timers: [] };
  };

  // Tear down any in-flight scan on unmount / connection switch.
  useEffect(() => cleanup, []);

  /** Scatter-gather one `$SRV.*` request: subscribe an inbox, publish, collect until quiet. */
  const scatter = <T,>(subject: string): Promise<T[]> =>
    new Promise((resolve) => {
      const inbox = `_INBOX.svc.${crypto.randomUUID()}`;
      const collected: T[] = [];
      ipc.pubsub
        .subscribe({ connectionId: connId, subject: inbox }, (event: SubStreamEvent) => {
          if (event.kind === "message") {
            const v = decodeJson<T>(event.data.payloadBase64);
            if (v) collected.push(v);
          } else if (event.kind === "error") {
            setError(`${event.data.code}: ${event.data.message}`);
          }
        })
        .then((handle) => {
          activeRef.current.handles.push(handle.subscriptionId);
          return ipc.pubsub.publish({
            connectionId: connId,
            subject,
            payload: "",
            encoding: PayloadEncoding.Utf8,
            headers: [],
            reply: inbox,
          });
        })
        .then(() => {
          activeRef.current.timers.push(setTimeout(() => resolve(collected), SCAN_WINDOW_MS));
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : String(e));
          resolve(collected);
        });
    });

  const discover = async (): Promise<void> => {
    cleanup();
    setError(null);
    setServices([]);
    setExpanded(new Set());
    setOpenEndpoints(new Set());
    setScanning(true);
    try {
      const [pings, stats, infos, schemas] = await Promise.all([
        scatter<PingReply>("$SRV.PING"),
        scatter<StatsReply>("$SRV.STATS"),
        scatter<InfoReply>("$SRV.INFO"),
        scatter<SchemaReply>("$SRV.SCHEMA"),
      ]);
      cleanup();
      setServices(merge(pings, stats, infos, schemas));
      setScanned(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  const toggle = (name: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const toggleEndpoint = (key: string): void =>
    setOpenEndpoints((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const instanceCount = services.reduce((n, s) => n + s.instances.length, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-2">
          <SectionLabel>Micro-services</SectionLabel>
          {services.length > 0 && (
            <Badge tone="accent">
              {services.length} {services.length === 1 ? "service" : "services"} · {instanceCount}{" "}
              {instanceCount === 1 ? "instance" : "instances"}
            </Badge>
          )}
        </div>
        <Button icon="grid" onClick={() => void discover()} disabled={scanning}>
          {scanning ? "Scanning…" : "Discover"}
        </Button>
      </div>

      {error && <p className="border-b border-border px-4 py-2 text-xs text-danger">{error}</p>}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {scanning ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
            <Icon name="dot" className="animate-pulse" size={26} />
            <p className="text-sm">Discovering $SRV.PING / STATS / INFO / SCHEMA…</p>
          </div>
        ) : services.length === 0 ? (
          <EmptyState
            icon="grid"
            title={scanned ? "No services responded" : "Discover NATS micro-services"}
            action={
              <Button icon="grid" onClick={() => void discover()}>
                Discover
              </Button>
            }
          >
            {scanned
              ? "No services responded — is anyone running a NATS micro service?"
              : "Send $SRV.PING / STATS / INFO / SCHEMA and list every micro-service, its instances, per-endpoint stats and schema."}
          </EmptyState>
        ) : (
          <ul className="space-y-2">
            {services.map((s) => {
              const open = expanded.has(s.name);
              return (
                <li key={s.name}>
                  <Panel>
                    <button
                      type="button"
                      onClick={() => toggle(s.name)}
                      aria-expanded={open}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left"
                    >
                      <Icon name={open ? "chevron-down" : "chevron-right"} size={16} />
                      <span className="flex-1 truncate text-sm font-semibold text-content">
                        {s.name}
                      </span>
                      {s.endpoints.length > 0 && (
                        <Badge tone="neutral">
                          {s.endpoints.length}{" "}
                          {s.endpoints.length === 1 ? "endpoint" : "endpoints"}
                        </Badge>
                      )}
                      <Badge tone="neutral">v{s.versions.join(", v")}</Badge>
                      <Badge tone="accent">
                        <Icon name="check" size={12} />
                        {s.instances.length}
                      </Badge>
                    </button>

                    {open && (
                      <div className="border-t border-border/60">
                        {s.description && (
                          <p className="px-4 pt-3 text-xs text-muted">{s.description}</p>
                        )}

                        <div className="flex flex-wrap gap-1.5 px-4 py-3">
                          {s.instances.map((inst) => (
                            <span
                              key={inst.id}
                              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted"
                            >
                              <Icon name="dot" size={10} className="text-accent" />
                              <span className="truncate">{inst.id}</span>
                              <span className="text-faint">v{inst.version}</span>
                            </span>
                          ))}
                        </div>

                        {s.endpoints.length === 0 ? (
                          <p className="px-4 pb-3 text-xs text-faint">
                            No endpoints published (responded to PING only).
                          </p>
                        ) : (
                          <div className="overflow-x-auto border-t border-border/40">
                            <table className="w-full min-w-[560px] text-left text-xs">
                              <thead>
                                <tr className="text-faint">
                                  <th className="px-4 py-2 font-medium">Endpoint</th>
                                  <th className="px-2 py-2 font-medium">Subject</th>
                                  <th className="px-2 py-2 text-right font-medium">Requests</th>
                                  <th className="px-2 py-2 text-right font-medium">Errors</th>
                                  <th className="px-2 py-2 text-right font-medium">Avg</th>
                                  <th className="px-2 py-2" />
                                </tr>
                              </thead>
                              <tbody>
                                {s.endpoints.map((epRow) => {
                                  const epKey = `${s.name} ${epRow.key}`;
                                  const epOpen = openEndpoints.has(epKey);
                                  return (
                                    <Fragment key={epRow.key}>
                                      <tr className="border-t border-border/40">
                                        <td className="px-4 py-2 font-medium text-content">
                                          {epRow.name}
                                        </td>
                                        <td className="max-w-[220px] truncate px-2 py-2 font-mono text-muted">
                                          {epRow.subject ?? "—"}
                                        </td>
                                        <td className="px-2 py-2 text-right tabular-nums text-muted">
                                          {epRow.hasStats ? epRow.numRequests.toLocaleString() : "—"}
                                        </td>
                                        <td
                                          className={cx(
                                            "px-2 py-2 text-right tabular-nums",
                                            epRow.numErrors > 0 ? "text-danger" : "text-muted",
                                          )}
                                        >
                                          {epRow.hasStats ? epRow.numErrors.toLocaleString() : "—"}
                                        </td>
                                        <td className="px-2 py-2 text-right tabular-nums text-muted">
                                          {epRow.hasStats ? fmtNs(epRow.avgProcessingNs) : "—"}
                                        </td>
                                        <td className="px-2 py-2 text-right">
                                          <button
                                            type="button"
                                            onClick={() => toggleEndpoint(epKey)}
                                            aria-expanded={epOpen}
                                            aria-label="Toggle schema"
                                            className="text-muted transition-colors hover:text-content"
                                          >
                                            <Icon
                                              name={epOpen ? "chevron-down" : "chevron-right"}
                                              size={14}
                                            />
                                          </button>
                                        </td>
                                      </tr>
                                      {epOpen && (
                                        <tr>
                                          <td colSpan={6} className="bg-surface-2/40 px-4 py-3">
                                            <div className="space-y-3">
                                              {epRow.queueGroup && (
                                                <div className="text-[11px] text-muted">
                                                  <span className="text-faint">queue group: </span>
                                                  <span className="font-mono">{epRow.queueGroup}</span>
                                                </div>
                                              )}
                                              {epRow.metadata &&
                                                Object.keys(epRow.metadata).length > 0 && (
                                                  <div className="flex flex-wrap gap-1.5">
                                                    {Object.entries(epRow.metadata).map(([k, v]) => (
                                                      <span
                                                        key={k}
                                                        className="rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px] text-muted"
                                                      >
                                                        {k}={String(v)}
                                                      </span>
                                                    ))}
                                                  </div>
                                                )}
                                              {epRow.lastError && (
                                                <div className="text-[11px] text-danger">
                                                  <span className="text-faint">last error: </span>
                                                  {epRow.lastError}
                                                </div>
                                              )}
                                              <div className="grid gap-3 md:grid-cols-2">
                                                <SchemaPane label="Request" schema={epRow.requestSchema} />
                                                <SchemaPane
                                                  label="Response"
                                                  schema={epRow.responseSchema}
                                                />
                                              </div>
                                            </div>
                                          </td>
                                        </tr>
                                      )}
                                    </Fragment>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                  </Panel>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function SchemaPane({ label, schema }: { label: string; schema: unknown }): JSX.Element {
  const empty =
    schema === undefined ||
    schema === null ||
    (typeof schema === "string" && schema.trim() === "") ||
    (typeof schema === "object" && Object.keys(schema as object).length === 0);
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</div>
      {empty ? (
        <p className="text-[11px] text-faint">no schema published</p>
      ) : (
        <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-surface p-2 font-mono text-[11px] leading-relaxed text-muted">
          {typeof schema === "string" ? schema : JSON.stringify(schema, null, 2)}
        </pre>
      )}
    </div>
  );
}
