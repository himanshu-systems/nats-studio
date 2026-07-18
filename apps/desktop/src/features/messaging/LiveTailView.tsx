import { useEffect, useRef, useState } from "react";
import { ipc, type MessageView, type SubStreamEvent } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Button, Badge, SectionLabel, cx } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { errorMessage, fmtBytes, MessageMeta, PayloadView } from "./message";

const MAX_MESSAGES = 1000;

interface ActiveSub {
  id: string;
  subject: string;
}

export function LiveTailView(): JSX.Element {
  return <RequireConnection>{(connId) => <LiveTail connId={connId} />}</RequireConnection>;
}

function LiveTail({ connId }: { connId: string }): JSX.Element {
  const [subject, setSubject] = useState("demo.>");
  const [queueGroup, setQueueGroup] = useState("");
  const [subs, setSubs] = useState<ActiveSub[]>([]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [selected, setSelected] = useState<MessageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [paused, setPaused] = useState(false);

  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const subsRef = useRef<ActiveSub[]>([]);
  subsRef.current = subs;

  // Auto-select the newest message when nothing is selected, so the formatted
  // payload + format tabs are visible immediately (no click needed).
  useEffect(() => {
    setSelected((cur) => cur ?? messages[0] ?? null);
  }, [messages]);

  // Tear down every subscription when leaving the view / switching connection.
  useEffect(
    () => () => {
      for (const s of subsRef.current) void ipc.pubsub.unsubscribe(s.id);
    },
    [],
  );

  const onEvent = (event: SubStreamEvent): void => {
    if (event.kind === "message") {
      if (pausedRef.current) return;
      setMessages((prev) => [event.data, ...prev].slice(0, MAX_MESSAGES));
    } else if (event.kind === "error") {
      setError(`${event.data.code}: ${event.data.message}`);
    }
  };

  const startSub = async (): Promise<void> => {
    const subj = subject.trim();
    if (subj === "") return;
    setError(null);
    setStarting(true);
    try {
      const handle = await ipc.pubsub.subscribe(
        { connectionId: connId, subject: subj, queueGroup: queueGroup.trim() || undefined },
        onEvent,
      );
      setSubs((prev) => [...prev, { id: handle.subscriptionId, subject: subj }]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const stopSub = (id: string): void => {
    void ipc.pubsub.unsubscribe(id);
    setSubs((prev) => prev.filter((s) => s.id !== id));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void startSub();
        }}
        className="space-y-2 border-b border-border bg-surface px-4 py-3"
      >
        <div className="flex gap-2">
          <input className="field" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="events.>" />
          <input
            className="field max-w-[160px]"
            value={queueGroup}
            onChange={(e) => setQueueGroup(e.target.value)}
            placeholder="queue group (opt.)"
          />
          <Button type="submit" icon="signal" disabled={starting || subject.trim() === ""}>
            {starting ? "…" : "Subscribe"}
          </Button>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        {subs.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {subs.map((s) => (
              <span
                key={s.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                {s.subject}
                <button type="button" onClick={() => stopSub(s.id)} aria-label={`Unsubscribe ${s.subject}`} className="opacity-70 hover:opacity-100">
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
      </form>

      <div className="flex items-center justify-between border-b border-border px-4 py-1.5">
        <div className="flex items-center gap-2">
          <SectionLabel>Live messages</SectionLabel>
          <Badge tone={paused ? "warning" : "positive"}>{messages.length}</Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" icon={paused ? "signal" : "clock"} onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            onClick={() => {
              setMessages([]);
              setSelected(null);
            }}
            disabled={messages.length === 0}
          >
            Clear
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] divide-x divide-border">
        <ul className="min-h-0 overflow-auto">
          {messages.length === 0 && (
            <li className="p-4 text-xs text-muted">
              Waiting for messages… publish to a matching subject to see them arrive live.
            </li>
          )}
          {messages.map((m) => (
            <li key={`${m.subject}-${m.seq}-${m.ts}`}>
              <button
                type="button"
                onClick={() => setSelected(m)}
                className={cx(
                  "block w-full border-b border-border/60 px-4 py-2 text-left transition-colors hover:bg-surface-2",
                  selected === m && "bg-surface-2",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-content">{m.subject}</span>
                  <span className="flex shrink-0 items-center gap-2 text-[10px] text-faint">
                    <span className="tabular-nums">{fmtBytes(m.size)}</span>
                    <span className="uppercase">{m.format}</span>
                  </span>
                </div>
                <div className="truncate font-mono text-xs text-muted">{m.preview.slice(0, 100)}</div>
              </button>
            </li>
          ))}
        </ul>

        <div className="min-h-0 overflow-auto p-4">
          {selected ? (
            <div className="space-y-2">
              <MessageMeta view={selected} />
              <PayloadView view={selected} />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted">Select a message to inspect its payload and headers.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
