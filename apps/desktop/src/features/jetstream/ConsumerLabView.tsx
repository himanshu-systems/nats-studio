import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, NatsStudioError, PayloadEncoding } from "@bindings";
import type { FetchedMessageDto, MessageView } from "@bindings";
import { LIST_REFETCH_MS } from "../../lib/liveEvents";
import { useUiStore } from "../../lib/uiStore";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, Panel, SectionLabel, cx } from "../../components/ui";
import { Select } from "../../components/Select";
import { ErrorNote } from "../../components/ErrorNote";
import { useConfirm } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { PayloadView } from "../messaging/message";

const streamsKey = (connId: string): [string, string] => ["streams", connId];
const consumersKey = (connId: string, stream: string): [string, string, string] => [
  "consumers",
  connId,
  stream,
];

/** The three interactive ack outcomes → the tiny body published to `ackSubject`. */
const ACK_BODY = { ack: "+ACK", nak: "-NAK", term: "+TERM" } as const;
type AckAction = keyof typeof ACK_BODY;

/** Decode base64 to UTF-8, or `null` if the bytes aren't valid UTF-8 (binary). */
function base64ToUtf8(b64: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Adapt a fetched JetStream message into the shared `MessageView` for `PayloadView`. */
function toView(msg: FetchedMessageDto): MessageView {
  const text = base64ToUtf8(msg.payloadBase64);
  return {
    seq: msg.streamSeq,
    subject: msg.subject,
    headers: msg.headers,
    payloadBase64: msg.payloadBase64,
    size: msg.size,
    format: text === null ? "binary" : "text",
    compression: "none",
    preview: text ?? msg.payloadBase64,
    ts: new Date().toISOString(),
  };
}

export function ConsumerLabView(): JSX.Element {
  return <RequireConnection>{(connId) => <ConsumerLab connId={connId} />}</RequireConnection>;
}

function ConsumerLab({ connId }: { connId: string }): JSX.Element {
  const qc = useQueryClient();
  const setView = useUiStore((s) => s.setView);
  const openLiveTail = useUiStore((s) => s.openLiveTail);
  const streams = useQuery({
    queryKey: streamsKey(connId),
    queryFn: () => ipc.jetstream.listStreams({ connectionId: connId }),
    refetchInterval: LIST_REFETCH_MS,
  });
  const streamNames = (streams.data?.streams ?? []).map((s) => s.config.name);

  const [pickedStream, setPickedStream] = useState<string | null>(null);
  const stream = pickedStream ?? streamNames[0] ?? null;

  const consumers = useQuery({
    queryKey: consumersKey(connId, stream ?? ""),
    queryFn: () => ipc.jetstream.listConsumers({ connectionId: connId, streamName: stream ?? "" }),
    enabled: stream !== null,
    refetchInterval: LIST_REFETCH_MS,
  });
  const consumerList = consumers.data?.consumers ?? [];
  const consumerNames = consumerList.map((c) => c.name);

  const [pickedConsumer, setPickedConsumer] = useState<string | null>(null);
  const consumer = pickedConsumer ?? consumerNames[0] ?? null;
  const consumerInfo = consumerList.find((c) => c.name === consumer) ?? null;
  const pending = consumerInfo?.numPending ?? null;
  const isPushConsumer = consumerInfo !== null && !consumerInfo.isPull;
  const isRefreshing = streams.isFetching || consumers.isFetching;
  const refetchAll = (): void => {
    void streams.refetch();
    if (stream) void consumers.refetch();
  };
  const refreshConsumers = (): void => {
    void qc.invalidateQueries({ queryKey: consumersKey(connId, stream ?? "") });
  };

  const [batch, setBatch] = useState(10);
  const [messages, setMessages] = useState<FetchedMessageDto[]>([]);
  const [acted, setActed] = useState<Record<number, AckAction>>({});
  const [actErrors, setActErrors] = useState<Record<number, unknown>>({});
  const [actingSeq, setActingSeq] = useState<number | null>(null);
  const [lastFetch, setLastFetch] = useState<{ requested: number; received: number } | null>(null);

  const pickStream = (v: string | null): void => {
    setPickedStream(v);
    setPickedConsumer(null);
    setLastFetch(null);
    setMessages([]);
    setActed({});
    setActErrors({});
  };
  const pickConsumer = (v: string | null): void => {
    setPickedConsumer(v);
    setLastFetch(null);
    setMessages([]);
    setActed({});
    setActErrors({});
  };

  const fetch = useMutation({
    mutationFn: () =>
      ipc.jetstream.fetchMessages({
        connectionId: connId,
        stream: stream ?? "",
        consumer: consumer ?? "",
        batch,
      }),
    onSuccess: (resp) => {
      setMessages(resp.messages);
      setActed({});
      setActErrors({});
      setLastFetch({ requested: batch, received: resp.messages.length });
      refreshConsumers();
    },
    onError: (err) => {
      // Stream/consumer vanished underneath us (deleted elsewhere) — refresh
      // the pickers instead of leaving the user stuck on a dead selection.
      if (err instanceof NatsStudioError && (err.code === "STREAM_NOT_FOUND" || err.code === "CONSUMER_NOT_FOUND")) {
        void qc.invalidateQueries({ queryKey: streamsKey(connId) });
        refreshConsumers();
      }
    },
  });

  const publish = useMutation({
    mutationFn: (vars: { subject: string; payload: string }) =>
      ipc.pubsub.publish({
        connectionId: connId,
        subject: vars.subject,
        payload: vars.payload,
        encoding: PayloadEncoding.Utf8,
        headers: [],
      }),
  });

  const act = (msg: FetchedMessageDto, action: AckAction): void => {
    if (!msg.ackSubject) return;
    setActingSeq(msg.streamSeq);
    setActErrors((e) => {
      if (!(msg.streamSeq in e)) return e;
      const next = { ...e };
      delete next[msg.streamSeq];
      return next;
    });
    publish.mutate(
      { subject: msg.ackSubject, payload: ACK_BODY[action] },
      {
        onSuccess: () => {
          setActed((a) => ({ ...a, [msg.streamSeq]: action }));
          refreshConsumers();
        },
        onError: (err) => {
          setActErrors((e) => ({ ...e, [msg.streamSeq]: err }));
        },
        onSettled: () => {
          setActingSeq(null);
        },
      },
    );
  };

  return (
    <div className="h-full space-y-3 overflow-auto p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionLabel>Consumer Lab{messages.length > 0 ? ` (${messages.length})` : ""}</SectionLabel>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="max-w-[180px]"
            value={stream ?? ""}
            onChange={pickStream}
            options={streamNames.map((n) => ({ value: n, label: n }))}
            disabled={streamNames.length === 0}
            placeholder="No streams"
          />
          <Select
            className="max-w-[200px]"
            value={consumer ?? ""}
            onChange={pickConsumer}
            options={consumerList.map((c) => ({
              value: c.name,
              label: c.name,
              hint: c.isPull ? `${(c.numPending ?? 0)} pending` : "push — can't fetch",
            }))}
            disabled={consumerList.length === 0}
            placeholder="No consumers"
          />
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
          {consumer && isPushConsumer && <Badge tone="warning">push consumer</Badge>}
          {consumer && !isPushConsumer && pending != null && (
            <Badge tone={pending > 0 ? "positive" : "neutral"}>{pending} pending</Badge>
          )}
          <input
            type="number"
            min={1}
            max={100}
            className="field h-8 w-16 text-xs"
            value={batch}
            onChange={(e) => setBatch(Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
            aria-label="Batch size"
          />
          <Button
            size="sm"
            icon="beaker"
            onClick={() => fetch.mutate()}
            disabled={consumer === null || isPushConsumer || fetch.isPending}
          >
            {fetch.isPending ? "Fetching…" : "Fetch"}
          </Button>
        </div>
      </div>

      {streams.isError && <ErrorNote error={streams.error} />}
      {consumers.isError && <ErrorNote error={consumers.error} />}
      {fetch.isError && <ErrorNote error={fetch.error} />}

      {consumerInfo && (
        <Panel className="p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-content">{consumerInfo.name}</span>
              <Badge tone={consumerInfo.isPull ? "neutral" : "warning"}>
                {consumerInfo.isPull ? "Pull" : "Push"}
              </Badge>
              <Badge tone="neutral">Deliver: {consumerInfo.deliverPolicy}</Badge>
              <Badge tone="neutral">Ack: {consumerInfo.ackPolicy}</Badge>
              <span className="font-mono text-muted">
                {consumerInfo.filterSubject ? `filter: ${consumerInfo.filterSubject}` : "(all subjects)"}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-muted">
              <span>Ack floor: <strong className="tabular-nums text-content">#{consumerInfo.ackFloorStreamSeq}</strong></span>
              <span>Last delivered: <strong className="tabular-nums text-content">#{consumerInfo.deliveredStreamSeq}</strong></span>
              <span>Pending: <strong className="tabular-nums text-content">{consumerInfo.numPending}</strong></span>
              {consumerInfo.numAckPending > 0 && (
                <span>Un-acked: <strong className="tabular-nums text-warning">{consumerInfo.numAckPending}</strong></span>
              )}
            </div>
          </div>
        </Panel>
      )}

      {messages.length === 0 ? (
        isPushConsumer ? (
          <EmptyState
            icon="alert"
            title="Push consumer — messages arrive on a subject"
            action={
              consumerInfo?.deliverSubject ? (
                <Button icon="signal" onClick={() => openLiveTail(consumerInfo.deliverSubject!)}>
                  Watch “{consumerInfo.deliverSubject}” in Live Tail
                </Button>
              ) : undefined
            }
          >
            The server pushes this consumer’s messages to its deliver subject as they arrive, so there
            is nothing to fetch here — that’s how NATS works, not a limit of this app. Pull consumers
            hand you a batch on request; push consumers deliver on their own, and you read them by
            subscribing to that subject.
          </EmptyState>
        ) : lastFetch !== null && lastFetch.received === 0 ? (
          <EmptyState
            icon="beaker"
            title="Fetch completed — 0 messages returned"
            action={
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" icon="inbox" onClick={() => setView("browser")}>
                  Check stream in Message Browser
                </Button>
                <Button size="sm" icon="replay" onClick={() => fetch.mutate()} disabled={fetch.isPending}>
                  Try fetching again
                </Button>
              </div>
            }
          >
            Requested {lastFetch.requested}, received 0. Either nothing is pending right now for this consumer (all messages up to #{consumerInfo?.deliveredStreamSeq ?? 0} have been delivered), another puller claimed them, or the 2s wait expired.
          </EmptyState>
        ) : consumer !== null && pending === 0 ? (
          <EmptyState
            icon="beaker"
            title="No pending messages for this consumer"
            action={
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" icon="inbox" onClick={() => setView("browser")}>
                  View all stream messages in Message Browser
                </Button>
                <Button size="sm" icon="send" onClick={() => setView("publisher")}>
                  Publish to stream
                </Button>
              </div>
            }
          >
            Consumer “{consumer}” is caught up (ack floor #{consumerInfo?.ackFloorStreamSeq ?? 0}, last delivered #{consumerInfo?.deliveredStreamSeq ?? 0}). All existing messages matching filter “{consumerInfo?.filterSubject || "*"}” have been delivered. Publish a new message or check Message Browser to see stream history.
          </EmptyState>
        ) : (
          <EmptyState icon="beaker" title="No messages fetched yet">
            Pick a pull consumer with pending messages and click Fetch. (Push consumers can't be
            pulled.)
          </EmptyState>
        )
      ) : (
        <ul className="space-y-2.5">
          {messages.map((m, i) => (
            <MessageRow
              key={`${m.streamSeq}-${i}`}
              msg={m}
              acted={acted[m.streamSeq]}
              acting={actingSeq === m.streamSeq}
              error={actErrors[m.streamSeq]}
              onAct={act}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const ACTED_LABEL: Record<AckAction, string> = { ack: "Acked", nak: "Nak’d", term: "Termed" };
const ACTED_TONE: Record<AckAction, "positive" | "warning" | "danger"> = {
  ack: "positive",
  nak: "warning",
  term: "danger",
};

function MessageRow({
  msg,
  acted,
  acting,
  error,
  onAct,
}: {
  msg: FetchedMessageDto;
  acted: AckAction | undefined;
  acting?: boolean;
  error: unknown;
  onAct: (msg: FetchedMessageDto, action: AckAction) => void;
}): JSX.Element {
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const view = toView(msg);
  return (
    <Panel className={acted ? "space-y-3 p-4 opacity-60" : "space-y-3 p-4"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone="neutral">{msg.streamSeq > 0 ? `#${msg.streamSeq}` : "#—"}</Badge>
          <Badge tone={msg.numDelivered > 1 ? "warning" : "neutral"}>
            delivered ×{msg.numDelivered}
          </Badge>
          <span className="truncate font-mono text-sm text-content">{msg.subject}</span>
          <span className="shrink-0 tabular-nums text-faint">{msg.size} B</span>
        </div>
        {acted ? (
          <Badge tone={ACTED_TONE[acted]}>{ACTED_LABEL[acted]}</Badge>
        ) : !msg.ackSubject ? (
          <Badge tone="neutral">Ack not required</Badge>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" icon="check" onClick={() => onAct(msg, "ack")} disabled={acting}>
              Ack
            </Button>
            <Button size="sm" variant="outline" icon="alert" onClick={() => onAct(msg, "nak")} disabled={acting}>
              Nak
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon="x"
              disabled={acting}
              onClick={() => {
                void confirm({
                  title: `Terminate message #${msg.streamSeq}?`,
                  description: `On subject "${msg.subject}".`,
                  consequences: [
                    "It's marked permanently failed and won't be redelivered to this or any other consumer.",
                    msg.numDelivered > 1 ? `It was already delivered ${msg.numDelivered} times.` : "",
                  ].filter(Boolean),
                  confirmLabel: "Terminate",
                  confirmIcon: "x",
                }).then((ok) => {
                  if (ok) onAct(msg, "term");
                });
              }}
            >
              Term
            </Button>
          </div>
        )}
      </div>
      {error !== undefined && <ErrorNote error={error} />}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-md text-left text-xs text-muted transition-colors hover:text-content"
      >
        <Icon
          name="chevron-down"
          size={12}
          className={cx("shrink-0 transition-transform", open && "rotate-180")}
        />
        {open ? <span>Hide payload</span> : <span className="truncate font-mono">{view.preview || "(empty payload)"}</span>}
      </button>
      {open && <PayloadView view={view} />}
    </Panel>
  );
}
