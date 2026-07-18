import { useEffect, useRef, useState } from "react";
import {
  ipc,
  PayloadEncoding,
  type SubStreamEvent,
  type SubscriptionHandle,
} from "@bindings";
import { RequireConnection } from "@/components/RequireConnection";
import { Panel, Badge, Button, EmptyState, SectionLabel, cx } from "@/components/ui";
import { Icon } from "@/components/Icon";

/** One `$SRV.PING` reply from a running micro-service instance. */
interface PingReply {
  name?: string;
  id?: string;
  version?: string;
}

interface Instance {
  id: string;
  version: string;
}

interface ServiceGroup {
  name: string;
  instances: Instance[];
  versions: string[];
}

/** How long to collect scatter-gather replies before rendering. */
const SCAN_WINDOW_MS = 1500;

export function ServicesView(): JSX.Element {
  return <RequireConnection>{(connId) => <Services connId={connId} />}</RequireConnection>;
}

function decodePing(payloadBase64: string): PingReply | null {
  try {
    const bin = atob(payloadBase64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as PingReply;
    return parsed;
  } catch {
    return null;
  }
}

function group(replies: PingReply[]): ServiceGroup[] {
  const byName = new Map<string, ServiceGroup>();
  for (const r of replies) {
    const name = r.name ?? "(unnamed)";
    const id = r.id ?? "(no id)";
    const version = r.version ?? "?";
    let g = byName.get(name);
    if (!g) {
      g = { name, instances: [], versions: [] };
      byName.set(name, g);
    }
    // A service instance replies once, but guard against duplicates anyway.
    if (!g.instances.some((i) => i.id === id)) g.instances.push({ id, version });
    if (!g.versions.includes(version)) g.versions.push(version);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function Services({ connId }: { connId: string }): JSX.Element {
  const [services, setServices] = useState<ServiceGroup[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const handleRef = useRef<SubscriptionHandle | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collectedRef = useRef<PingReply[]>([]);

  const cleanup = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (handleRef.current) {
      void ipc.pubsub.unsubscribe(handleRef.current.subscriptionId);
      handleRef.current = null;
    }
  };

  // Tear down any in-flight scan on unmount / connection switch.
  useEffect(() => cleanup, []);

  const onEvent = (event: SubStreamEvent): void => {
    if (event.kind === "message") {
      const reply = decodePing(event.data.payloadBase64);
      if (reply) collectedRef.current.push(reply);
    } else if (event.kind === "error") {
      setError(`${event.data.code}: ${event.data.message}`);
    }
  };

  const discover = async (): Promise<void> => {
    cleanup();
    collectedRef.current = [];
    setError(null);
    setServices([]);
    setExpanded(new Set());
    setScanning(true);

    const inbox = `_INBOX.svc.${crypto.randomUUID()}`;
    try {
      const handle = await ipc.pubsub.subscribe({ connectionId: connId, subject: inbox }, onEvent);
      handleRef.current = handle;
      await ipc.pubsub.publish({
        connectionId: connId,
        subject: "$SRV.PING",
        payload: "",
        encoding: PayloadEncoding.Utf8,
        headers: [],
        reply: inbox,
      });
      timerRef.current = setTimeout(() => {
        cleanup();
        setServices(group(collectedRef.current));
        setScanned(true);
        setScanning(false);
      }, SCAN_WINDOW_MS);
    } catch (e) {
      cleanup();
      setError(e instanceof Error ? e.message : String(e));
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
            <p className="text-sm">Scanning $SRV.PING…</p>
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
              : "Send a $SRV.PING request and list every micro-service instance that replies."}
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
                      <Badge tone="neutral">v{s.versions.join(", v")}</Badge>
                      <Badge tone="accent">
                        <Icon name="check" size={12} />
                        {s.instances.length}
                      </Badge>
                    </button>
                    {open && (
                      <ul className="border-t border-border/60">
                        {s.instances.map((inst) => (
                          <li
                            key={inst.id}
                            className={cx(
                              "flex items-center gap-2 px-4 py-2 font-mono text-xs text-muted",
                            )}
                          >
                            <Icon name="dot" size={12} className="text-accent" />
                            <span className="flex-1 truncate">{inst.id}</span>
                            <span className="text-faint">v{inst.version}</span>
                          </li>
                        ))}
                      </ul>
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
