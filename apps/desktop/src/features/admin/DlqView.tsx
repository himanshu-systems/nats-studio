import { useEffect, useRef, useState } from "react";
import { ipc, type SubStreamEvent } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, SectionLabel, cx } from "../../components/ui";

const MAX_ROWS = 500;

// JetStream publishes poison-message advisories on these subjects. Wildcard tail
// is `<stream>.<consumer>`; we derive the kind from the subject, not a lib.
const ADVISORY_SUBJECTS = [
  "$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>",
  "$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.>",
] as const;

type Kind = "max_deliveries" | "terminated";

interface DlqRow {
  ts: string;
  kind: Kind;
  stream: string;
  consumer: string;
  streamSeq: number;
  deliveries: number;
}

const KIND_META: Record<Kind, { label: string; tone: "warning" | "danger" }> = {
  max_deliveries: { label: "max-deliveries", tone: "warning" },
  terminated: { label: "terminated", tone: "danger" },
};

/** atob → bytes → UTF-8 text. Advisory bodies are JSON. */
function decodeUtf8Base64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function DlqView(): JSX.Element {
  return <RequireConnection>{(connId) => <Dlq connId={connId} />}</RequireConnection>;
}

function Dlq({ connId }: { connId: string }): JSX.Element {
  const [rows, setRows] = useState<DlqRow[]>([]);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subsRef = useRef<string[]>([]);

  const onEvent = (event: SubStreamEvent): void => {
    if (event.kind === "error") {
      setError(`${event.data.code}: ${event.data.message}`);
      return;
    }
    if (event.kind !== "message") return;
    const view = event.data;
    try {
      const body = JSON.parse(decodeUtf8Base64(view.payloadBase64)) as {
        stream?: string;
        consumer?: string;
        stream_seq?: number;
        deliveries?: number;
      };
      const kind: Kind = view.subject.includes("MAX_DELIVERIES") ? "max_deliveries" : "terminated";
      const row: DlqRow = {
        ts: view.ts,
        kind,
        stream: body.stream ?? "—",
        consumer: body.consumer ?? "—",
        streamSeq: body.stream_seq ?? 0,
        deliveries: body.deliveries ?? 0,
      };
      setRows((prev) => [row, ...prev].slice(0, MAX_ROWS));
    } catch {
      // Non-JSON advisory body — ignore.
    }
  };

  const stop = (): void => {
    for (const id of subsRef.current) void ipc.pubsub.unsubscribe(id);
    subsRef.current = [];
    setListening(false);
  };

  const start = async (): Promise<void> => {
    if (subsRef.current.length > 0) return;
    setError(null);
    setListening(true);
    for (const subject of ADVISORY_SUBJECTS) {
      try {
        const handle = await ipc.pubsub.subscribe({ connectionId: connId, subject }, onEvent);
        subsRef.current.push(handle.subscriptionId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  // Auto-start on mount; tear every subscription down on unmount.
  useEffect(() => {
    void start();
    return () => {
      for (const id of subsRef.current) void ipc.pubsub.unsubscribe(id);
      subsRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <SectionLabel>Dead letters</SectionLabel>
          <Badge tone={listening ? "positive" : "neutral"}>{rows.length}</Badge>
          {listening && <span className="text-xs text-muted">listening…</span>}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            icon={listening ? "clock" : "alert"}
            onClick={() => (listening ? stop() : void start())}
          >
            {listening ? "Stop" : "Start"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            onClick={() => setRows([])}
            disabled={rows.length === 0}
          >
            Clear
          </Button>
        </div>
      </div>

      <p className="border-b border-border/60 px-4 py-1.5 text-xs text-muted">
        Redeliver &amp; purge coming in a later phase.
      </p>

      {error && <p className="border-b border-border/60 px-4 py-1.5 text-xs text-danger">{error}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <EmptyState icon="alert" title="No poison messages yet">
            Listening for poison-message advisories… none yet. These fire when a message exceeds
            MaxDeliver or is TERM'd by a consumer.
          </EmptyState>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-surface text-left">
              <tr className="border-b border-border text-[11px] uppercase tracking-wider text-muted">
                <th className="px-4 py-2 font-semibold">Time</th>
                <th className="px-4 py-2 font-semibold">Kind</th>
                <th className="px-4 py-2 font-semibold">Stream</th>
                <th className="px-4 py-2 font-semibold">Consumer</th>
                <th className="px-4 py-2 font-semibold">Seq</th>
                <th className="px-4 py-2 font-semibold">Deliveries</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.stream}-${r.consumer}-${r.streamSeq}-${r.ts}-${i}`}
                  className={cx("border-b border-border/60", i % 2 === 1 && "bg-surface-2/40")}
                >
                  <td className="whitespace-nowrap px-4 py-1.5 font-mono text-xs text-muted">
                    {new Date(r.ts).toLocaleTimeString()}
                  </td>
                  <td className="px-4 py-1.5">
                    <Badge tone={KIND_META[r.kind].tone}>{KIND_META[r.kind].label}</Badge>
                  </td>
                  <td className="px-4 py-1.5 font-medium text-content">{r.stream}</td>
                  <td className="px-4 py-1.5 text-content">{r.consumer}</td>
                  <td className="px-4 py-1.5 font-mono text-xs text-muted">{r.streamSeq}</td>
                  <td className="px-4 py-1.5 font-mono text-xs text-muted">{r.deliveries}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
