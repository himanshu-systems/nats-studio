import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ipc,
  NatsStudioError,
  PayloadEncoding,
  type MessageHeader,
  type MessageView,
  type SubStreamEvent,
} from "@bindings";

const CONNECTIONS_KEY = ["connection", "list"] as const;
const MAX_MESSAGES = 500;

const FIELD =
  "w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900";
const LABEL = "text-xs font-semibold uppercase tracking-wide opacity-50";

function errorMessage(e: unknown): string {
  if (e instanceof NatsStudioError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** Parse a `Key: Value` per-line textarea into wire headers, skipping blanks. */
function parseHeaders(raw: string): MessageHeader[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes(":"))
    .map((line) => {
      const idx = line.indexOf(":");
      return { name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
    })
    .filter((h) => h.name.length > 0);
}

/**
 * Phase 2 messaging workspace: pick a live connection, then publish / request on
 * the left and open streaming subscriptions on the right. Received messages are
 * decoded server-side (format + compression detection) and inspected inline.
 */
export function MessagingView(): JSX.Element {
  const connections = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: () => ipc.connection.list(),
    refetchInterval: 4000,
  });

  const items = useMemo(
    () => (connections.data?.connections ?? []).filter((c) => c.status === "connected"),
    [connections.data],
  );

  const [connId, setConnId] = useState<string | null>(null);
  // Keep the selection valid as connections come and go.
  useEffect(() => {
    if (items.length === 0) {
      setConnId(null);
    } else if (connId === null || !items.some((c) => c.connectionId === connId)) {
      setConnId(items[0].connectionId);
    }
  }, [items, connId]);

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <p className="max-w-sm text-sm opacity-40">
          No active connections. Open the <span className="font-medium">Connections</span> tab and
          connect to a NATS server to start publishing and subscribing.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
        <span className={LABEL}>Connection</span>
        <select
          className={`${FIELD} max-w-xs`}
          value={connId ?? ""}
          onChange={(e) => setConnId(e.target.value)}
        >
          {items.map((c) => (
            <option key={c.connectionId} value={c.connectionId}>
              {c.name} · {c.connectionId.slice(0, 8)}
            </option>
          ))}
        </select>
      </div>
      {connId && (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(340px,420px)_1fr] divide-x divide-slate-200 dark:divide-slate-800">
          <PublisherPanel connId={connId} />
          <SubscriberPanel connId={connId} />
        </div>
      )}
    </div>
  );
}

// --- Publisher / Request -----------------------------------------------------

function PublisherPanel(props: { connId: string }): JSX.Element {
  const { connId } = props;
  const [mode, setMode] = useState<"publish" | "request">("publish");
  const [subject, setSubject] = useState("demo.subject");
  const [payload, setPayload] = useState('{"hello":"world"}');
  const [encoding, setEncoding] = useState<PayloadEncoding>(PayloadEncoding.Utf8);
  const [headersRaw, setHeadersRaw] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(2000);
  const [reply, setReply] = useState<MessageView | null>(null);

  const publish = useMutation({
    mutationFn: () =>
      ipc.pubsub.publish({
        connectionId: connId,
        subject: subject.trim(),
        payload,
        encoding,
        headers: parseHeaders(headersRaw),
        reply: undefined,
      }),
  });

  const request = useMutation({
    mutationFn: () =>
      ipc.pubsub.request({
        connectionId: connId,
        subject: subject.trim(),
        payload,
        encoding,
        headers: parseHeaders(headersRaw),
        timeoutMs,
      }),
    onSuccess: (view) => setReply(view),
  });

  const active = mode === "publish" ? publish : request;
  const submit = (): void => {
    setReply(null);
    if (mode === "publish") publish.mutate();
    else request.mutate();
  };

  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 px-4 pt-4">
        <TabButton active={mode === "publish"} onClick={() => setMode("publish")}>
          Publish
        </TabButton>
        <TabButton active={mode === "request"} onClick={() => setMode("request")}>
          Request
        </TabButton>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="min-h-0 flex-1 space-y-3 overflow-auto p-4"
      >
        <label className="block space-y-1">
          <span className={LABEL}>Subject</span>
          <input
            className={FIELD}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="orders.new"
          />
        </label>

        <label className="block space-y-1">
          <span className={LABEL}>Payload</span>
          <textarea
            className={`${FIELD} min-h-[120px] font-mono`}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            spellCheck={false}
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className={LABEL}>Encoding</span>
            <select
              className={FIELD}
              value={encoding}
              onChange={(e) => setEncoding(e.target.value as PayloadEncoding)}
            >
              <option value={PayloadEncoding.Utf8}>UTF-8</option>
              <option value={PayloadEncoding.Base64}>Base64</option>
            </select>
          </label>
          {mode === "request" && (
            <label className="block space-y-1">
              <span className={LABEL}>Timeout (ms)</span>
              <input
                type="number"
                min={100}
                step={100}
                className={FIELD}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value) || 0)}
              />
            </label>
          )}
        </div>

        <label className="block space-y-1">
          <span className={LABEL}>Headers (one Key: Value per line)</span>
          <textarea
            className={`${FIELD} min-h-[56px] font-mono`}
            value={headersRaw}
            onChange={(e) => setHeadersRaw(e.target.value)}
            placeholder="X-Trace-Id: abc123"
            spellCheck={false}
          />
        </label>

        <button
          type="submit"
          disabled={active.isPending || subject.trim() === ""}
          className="w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {active.isPending
            ? mode === "publish"
              ? "Publishing…"
              : "Requesting…"
            : mode === "publish"
              ? "Publish"
              : "Send request"}
        </button>

        {publish.isSuccess && mode === "publish" && (
          <p className="text-xs text-emerald-600">Published to {subject.trim()}.</p>
        )}
        {active.isError && <p className="text-xs text-red-500">{errorMessage(active.error)}</p>}

        {mode === "request" && reply && (
          <div className="space-y-1 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
            <div className={LABEL}>Reply</div>
            <MessageMeta view={reply} />
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-xs dark:bg-slate-950">
              {reply.preview}
            </pre>
          </div>
        )}
      </form>
    </section>
  );
}

// --- Subscriber --------------------------------------------------------------

interface ActiveSub {
  id: string;
  subject: string;
}

function SubscriberPanel(props: { connId: string }): JSX.Element {
  const { connId } = props;
  const [subject, setSubject] = useState("demo.>");
  const [queueGroup, setQueueGroup] = useState("");
  const [subs, setSubs] = useState<ActiveSub[]>([]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [selected, setSelected] = useState<MessageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Track active subscription ids so we can tear them all down on unmount.
  const subsRef = useRef<ActiveSub[]>([]);
  subsRef.current = subs;
  useEffect(
    () => () => {
      for (const s of subsRef.current) void ipc.pubsub.unsubscribe(s.id);
    },
    [],
  );

  const onEvent = (event: SubStreamEvent): void => {
    if (event.kind === "message") {
      setMessages((prev) => [event.data, ...prev].slice(0, MAX_MESSAGES));
    } else if (event.kind === "error") {
      setError(`${event.data.code}: ${event.data.message}`);
    }
    // "ended" is handled by the unsubscribe UI; the stream simply stops.
  };

  const startSub = async (): Promise<void> => {
    const subj = subject.trim();
    if (subj === "") return;
    setError(null);
    setStarting(true);
    try {
      const handle = await ipc.pubsub.subscribe(
        {
          connectionId: connId,
          subject: subj,
          queueGroup: queueGroup.trim() === "" ? undefined : queueGroup.trim(),
        },
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
    <section className="grid min-h-0 grid-rows-[auto_auto_1fr]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void startSub();
        }}
        className="space-y-2 p-4"
      >
        <span className={LABEL}>Subscribe</span>
        <div className="flex gap-2">
          <input
            className={FIELD}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="events.>"
          />
          <input
            className={`${FIELD} max-w-[140px]`}
            value={queueGroup}
            onChange={(e) => setQueueGroup(e.target.value)}
            placeholder="queue (opt.)"
          />
          <button
            type="submit"
            disabled={starting || subject.trim() === ""}
            className="shrink-0 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {starting ? "…" : "Subscribe"}
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        {subs.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {subs.map((s) => (
              <span
                key={s.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {s.subject}
                <button
                  type="button"
                  onClick={() => stopSub(s.id)}
                  className="opacity-60 hover:opacity-100"
                  aria-label={`Unsubscribe from ${s.subject}`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </form>

      <div className="flex items-center justify-between border-y border-slate-200 px-4 py-1.5 dark:border-slate-800">
        <span className={LABEL}>Messages ({messages.length})</span>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setMessages([]);
              setSelected(null);
            }}
            className="text-xs opacity-60 hover:opacity-100"
          >
            Clear
          </button>
        )}
      </div>

      <div className="grid min-h-0 grid-cols-[1fr_minmax(0,1fr)] divide-x divide-slate-200 dark:divide-slate-800">
        <ul className="min-h-0 overflow-auto">
          {messages.length === 0 && (
            <li className="p-4 text-xs opacity-40">
              Waiting for messages… publish to a matching subject to see them arrive live.
            </li>
          )}
          {messages.map((m) => (
            <li key={`${m.subject}-${m.seq}-${m.ts}`}>
              <button
                type="button"
                onClick={() => setSelected(m)}
                className={`block w-full border-b border-slate-100 px-4 py-2 text-left hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-900 ${
                  selected === m ? "bg-slate-100 dark:bg-slate-800" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{m.subject}</span>
                  <span className="shrink-0 text-[10px] uppercase opacity-50">{m.format}</span>
                </div>
                <div className="truncate text-xs opacity-50">{m.preview.slice(0, 80)}</div>
              </button>
            </li>
          ))}
        </ul>

        <div className="min-h-0 overflow-auto p-4">
          {selected ? (
            <div className="space-y-2">
              <div className={LABEL}>Message</div>
              <MessageMeta view={selected} />
              {selected.headers.length > 0 && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t border-slate-100 pt-2 text-xs dark:border-slate-800">
                  {selected.headers.map((h, i) => (
                    <div key={i} className="contents">
                      <dt className="font-mono opacity-50">{h.name}</dt>
                      <dd className="truncate font-mono">{h.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-xs dark:bg-slate-950">
                {selected.preview}
              </pre>
            </div>
          ) : (
            <p className="text-xs opacity-40">Select a message to inspect its payload and headers.</p>
          )}
        </div>
      </div>
    </section>
  );
}

// --- shared bits -------------------------------------------------------------

function MessageMeta(props: { view: MessageView }): JSX.Element {
  const { view } = props;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs opacity-70">
      <span className="font-medium opacity-100">{view.subject}</span>
      <span>{view.size} B</span>
      <span>{view.format}</span>
      {view.compression !== "none" && <span>{view.compression}</span>}
      {view.reply && <span>reply → {view.reply}</span>}
      <span className="opacity-50">{view.ts}</span>
    </div>
  );
}

function TabButton(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`rounded-md px-3 py-1 text-sm font-medium ${
        props.active
          ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
          : "border border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
      }`}
    >
      {props.children}
    </button>
  );
}
