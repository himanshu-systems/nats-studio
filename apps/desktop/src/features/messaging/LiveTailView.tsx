import { useEffect, useRef, useState } from "react";
import { ipc, type MessageView, type SubStreamEvent } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Button, Badge, SectionLabel, cx } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { errorMessage, fmtBytes, MessageMeta, PayloadView } from "./message";

const MAX_MESSAGES = 1000;

interface ActiveSub {
  /** Server-side subscription id (for unsubscribe). */
  id: string;
  /** Client-side id used to tag this subscription's messages. */
  cid: string;
  subject: string;
}

/** A received message tagged with the client-side id of the subscription it came from. */
interface Tagged {
  cid: string;
  view: MessageView;
}

export function LiveTailView(): JSX.Element {
  return <RequireConnection>{(connId) => <LiveTail connId={connId} />}</RequireConnection>;
}

function LiveTail({ connId }: { connId: string }): JSX.Element {
  const [subject, setSubject] = useState("demo.>");
  const [queueGroup, setQueueGroup] = useState("");
  const [subs, setSubs] = useState<ActiveSub[]>([]);
  const [messages, setMessages] = useState<Tagged[]>([]);
  const [selected, setSelected] = useState<MessageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [paused, setPaused] = useState(false);
  // null = show all subscriptions; otherwise a subscription's client id.
  const [filter, setFilter] = useState<string | null>(null);

  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const subsRef = useRef<ActiveSub[]>([]);
  subsRef.current = subs;

  const shown = filter === null ? messages : messages.filter((m) => m.cid === filter);
  const countFor = (cid: string): number => messages.reduce((n, m) => n + (m.cid === cid ? 1 : 0), 0);

  // Auto-select the newest visible message when nothing is selected.
  useEffect(() => {
    setSelected((cur) => cur ?? shown[0]?.view ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, filter]);

  // Tear down every subscription when leaving the view / switching connection.
  useEffect(
    () => () => {
      for (const s of subsRef.current) void ipc.pubsub.unsubscribe(s.id);
    },
    [],
  );

  const makeOnEvent =
    (cid: string) =>
    (event: SubStreamEvent): void => {
      if (event.kind === "message") {
        if (pausedRef.current) return;
        setMessages((prev) => [{ cid, view: event.data }, ...prev].slice(0, MAX_MESSAGES));
      } else if (event.kind === "error") {
        setError(`${event.data.code}: ${event.data.message}`);
      }
    };

  const startSub = async (): Promise<void> => {
    const subj = subject.trim();
    if (subj === "") return;
    setError(null);
    setStarting(true);
    const cid = crypto.randomUUID();
    try {
      const handle = await ipc.pubsub.subscribe(
        { connectionId: connId, subject: subj, queueGroup: queueGroup.trim() || undefined },
        makeOnEvent(cid),
      );
      setSubs((prev) => [...prev, { id: handle.subscriptionId, cid, subject: subj }]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const stopSub = (sub: ActiveSub): void => {
    void ipc.pubsub.unsubscribe(sub.id);
    setSubs((prev) => prev.filter((s) => s.id !== sub.id));
    setFilter((f) => (f === sub.cid ? null : f));
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
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <FilterChip active={filter === null} count={messages.length} onClick={() => setFilter(null)}>
              All
            </FilterChip>
            {subs.map((s) => (
              <FilterChip
                key={s.cid}
                active={filter === s.cid}
                count={countFor(s.cid)}
                onClick={() => setFilter(s.cid)}
                onClose={() => stopSub(s)}
              >
                {s.subject}
              </FilterChip>
            ))}
          </div>
        )}
      </form>

      <div className="flex items-center justify-between border-b border-border px-4 py-1.5">
        <div className="flex items-center gap-2">
          <SectionLabel>{filter === null ? "Live messages" : `Filtered: ${subs.find((s) => s.cid === filter)?.subject ?? ""}`}</SectionLabel>
          <Badge tone={paused ? "warning" : "positive"}>{shown.length}</Badge>
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
          {shown.length === 0 && (
            <li className="p-4 text-xs text-muted">
              {messages.length === 0
                ? "Waiting for messages… publish to a matching subject to see them arrive live."
                : "No messages for this subscription yet."}
            </li>
          )}
          {shown.map((m, i) => (
            <li key={`${m.cid}-${m.view.seq}-${m.view.ts}-${i}`}>
              <button
                type="button"
                onClick={() => setSelected(m.view)}
                className={cx(
                  "block w-full border-b border-border/60 px-4 py-2 text-left transition-colors hover:bg-surface-2",
                  selected === m.view && "bg-surface-2",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-content">{m.view.subject}</span>
                  <span className="flex shrink-0 items-center gap-2 text-[10px] text-faint">
                    <span className="tabular-nums">{fmtBytes(m.view.size)}</span>
                    <span className="uppercase">{m.view.format}</span>
                  </span>
                </div>
                <div className="truncate font-mono text-xs text-muted">{m.view.preview.slice(0, 100)}</div>
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

function FilterChip({
  active,
  count,
  onClick,
  onClose,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  onClose?: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
        active
          ? "border-accent bg-accent text-accent-content"
          : "border-border bg-surface-2 text-muted hover:text-content",
      )}
    >
      <button type="button" onClick={onClick} className="flex items-center gap-1.5">
        <span className="truncate max-w-[180px]">{children}</span>
        <span className={cx("rounded-full px-1 tabular-nums", active ? "bg-black/15" : "bg-border/60")}>{count}</span>
      </button>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Unsubscribe" className="opacity-70 hover:opacity-100">
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}
