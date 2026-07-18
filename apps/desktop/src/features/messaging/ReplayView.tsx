import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc, PayloadEncoding } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, Panel, SectionLabel, cx } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { Select } from "../../components/Select";
import { errorMessage } from "./message";

const PAGE = 100;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Summary {
  published: number;
  failed: number;
  stopped: boolean;
}

export function ReplayView(): JSX.Element {
  return <RequireConnection>{(connId) => <Replay connId={connId} />}</RequireConnection>;
}

function Replay({ connId }: { connId: string }): JSX.Element {
  const streams = useQuery({
    queryKey: ["streams", connId],
    queryFn: () => ipc.jetstream.listStreams({ connectionId: connId }),
  });
  const streamNames = (streams.data?.streams ?? []).map((s) => s.config.name);

  const [pickedStream, setPickedStream] = useState<string | null>(null);
  const stream = pickedStream ?? streamNames[0] ?? null;

  // Probe first/last seq so the range defaults to the whole stream.
  const probe = useQuery({
    queryKey: ["replayProbe", connId, stream ?? ""],
    queryFn: () =>
      ipc.jetstream.getMessages({ connectionId: connId, stream: stream ?? "", startSeq: 1, limit: 1 }),
    enabled: stream !== null,
  });

  const [startSeq, setStartSeq] = useState(1);
  const [endSeq, setEndSeq] = useState(1);
  useEffect(() => {
    if (probe.data) {
      setStartSeq(probe.data.firstSeq);
      setEndSeq(probe.data.lastSeq);
    }
  }, [probe.data]);

  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [rate, setRate] = useState(20);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Summary>({ published: 0, failed: 0, stopped: false });
  const [done, setDone] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(false);

  const total = Math.max(0, endSeq - startSeq + 1);

  const remap = (subject: string): string => {
    const f = find.trim();
    if (f === "") return subject;
    return subject.startsWith(f) ? replace + subject.slice(f.length) : subject;
  };

  const run = async (): Promise<void> => {
    if (stream === null) return;
    abortRef.current = false;
    setRunning(true);
    setDone(null);
    setError(null);
    let published = 0;
    let failed = 0;
    setProgress({ published, failed, stopped: false });
    const delay = rate > 0 ? 1000 / rate : 0;
    let cursor = startSeq;
    try {
      while (!abortRef.current && cursor <= endSeq) {
        const res = await ipc.jetstream.getMessages({
          connectionId: connId,
          stream,
          startSeq: cursor,
          limit: PAGE,
        });
        // seq is ascending; keep only what's still inside the range.
        const batch = res.messages.filter((m) => m.seq <= endSeq);
        if (batch.length === 0) break;
        for (const m of batch) {
          if (abortRef.current) break;
          try {
            await ipc.pubsub.publish({
              connectionId: connId,
              subject: remap(m.subject),
              payload: m.payloadBase64,
              encoding: PayloadEncoding.Base64,
              headers: m.headers,
            });
            published++;
          } catch {
            failed++;
          }
          setProgress({ published, failed, stopped: false });
          if (delay > 0) await sleep(delay);
        }
        cursor = (res.messages.at(-1)?.seq ?? cursor) + 1;
      }
    } catch (e) {
      setError(errorMessage(e));
    }
    setRunning(false);
    setDone({ published, failed, stopped: abortRef.current });
  };

  const setNum = (setter: (n: number) => void) => (v: string) => setter(Math.max(0, Number(v) || 0));

  if (stream === null && !streams.isLoading) {
    return (
      <EmptyState icon="database" title="No streams">
        This account has no JetStream streams to replay from.
      </EmptyState>
    );
  }

  const pct = total > 0 ? Math.min(100, Math.round((progress.published / total) * 100)) : 0;

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-auto p-4">
      <div className="flex items-center gap-2">
        <Icon name="replay" size={18} className="text-accent" />
        <SectionLabel>Replay Studio</SectionLabel>
      </div>

      {streams.isError && <p className="text-xs text-danger">{errorMessage(streams.error)}</p>}

      <Panel className="space-y-3 p-4">
        <SectionLabel>Source</SectionLabel>
        <div className="grid grid-cols-3 gap-3">
          <label className="col-span-3 block space-y-1.5 sm:col-span-1">
            <span className="text-[11px] text-muted">Stream</span>
            <Select
              value={stream ?? ""}
              onChange={(v) => setPickedStream(v)}
              options={streamNames.map((n) => ({ value: n, label: n }))}
              disabled={running || streamNames.length === 0}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[11px] text-muted">Start seq</span>
            <input
              type="number"
              min={1}
              className="field tabular-nums"
              value={startSeq}
              onChange={(e) => setNum(setStartSeq)(e.target.value)}
              disabled={running}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[11px] text-muted">End seq</span>
            <input
              type="number"
              min={1}
              className="field tabular-nums"
              value={endSeq}
              onChange={(e) => setNum(setEndSeq)(e.target.value)}
              disabled={running}
            />
          </label>
        </div>
        {probe.data && (
          <p className="text-[11px] text-faint">
            Stored range: seq {probe.data.firstSeq}–{probe.data.lastSeq}
          </p>
        )}
      </Panel>

      <Panel className="space-y-3 p-4">
        <SectionLabel>Transform</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5">
            <span className="text-[11px] text-muted">Find subject prefix</span>
            <input
              className="field font-mono"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="(blank = keep original)"
              disabled={running}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[11px] text-muted">Replace with prefix</span>
            <input
              className="field font-mono"
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
              placeholder="orders.replay"
              disabled={running}
            />
          </label>
        </div>
        <p className="text-[11px] text-faint">
          Subjects starting with <code className="font-mono">{find || "…"}</code> get that prefix
          swapped for <code className="font-mono">{replace || "…"}</code>; others are republished as-is.
        </p>
      </Panel>

      <Panel className="space-y-3 p-4">
        <SectionLabel>Rate</SectionLabel>
        <label className="flex items-center gap-3">
          <input
            type="number"
            min={0}
            className="field w-28 tabular-nums"
            value={rate}
            onChange={(e) => setNum(setRate)(e.target.value)}
            disabled={running}
          />
          <span className="text-xs text-muted">messages / second — 0 = as fast as possible</span>
        </label>
      </Panel>

      <Panel className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>Run</SectionLabel>
          {running ? (
            <Button variant="danger" icon="x" onClick={() => (abortRef.current = true)}>
              Stop
            </Button>
          ) : (
            <Button
              icon="send"
              onClick={() => void run()}
              disabled={stream === null || total <= 0}
            >
              Run replay
            </Button>
          )}
        </div>

        {(running || done) && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="tabular-nums text-content">
                {progress.published} / {total} published
              </span>
              {progress.failed > 0 && <Badge tone="danger">{progress.failed} failed</Badge>}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                className={cx(
                  "h-full rounded-full transition-[width]",
                  progress.failed > 0 ? "bg-warning" : "bg-accent",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {done && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs">
            <Icon
              name={done.stopped ? "x" : "check"}
              size={15}
              className={done.stopped ? "text-warning" : "text-positive"}
            />
            <span className="text-content">
              {done.stopped ? "Stopped" : "Replay complete"} — {done.published} published
              {done.failed > 0 ? `, ${done.failed} failed` : ""}
            </span>
          </div>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}
      </Panel>
    </div>
  );
}
