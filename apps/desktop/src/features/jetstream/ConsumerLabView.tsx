import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, NatsStudioError, PayloadEncoding } from "@bindings";
import type { FetchedMessageDto, MessageView } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, Panel, SectionLabel } from "../../components/ui";
import { Select } from "../../components/Select";
import { ErrorNote } from "../../components/ErrorNote";
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
  const streams = useQuery({
    queryKey: streamsKey(connId),
    queryFn: () => ipc.jetstream.listStreams({ connectionId: connId }),
  });
  const streamNames = (streams.data?.streams ?? []).map((s) => s.config.name);

  const [pickedStream, setPickedStream] = useState<string | null>(null);
  const stream = pickedStream ?? streamNames[0] ?? null;

  const consumers = useQuery({
    queryKey: consumersKey(connId, stream ?? ""),
    queryFn: () => ipc.jetstream.listConsumers({ connectionId: connId, streamName: stream ?? "" }),
    enabled: stream !== null,
  });
  const consumerList = consumers.data?.consumers ?? [];
  const consumerNames = consumerList.map((c) => c.name);

  const [pickedConsumer, setPickedConsumer] = useState<string | null>(null);
  const consumer = pickedConsumer ?? consumerNames[0] ?? null;
  const consumerInfo = consumerList.find((c) => c.name === consumer) ?? null;
  const pending = consumerInfo?.numPending ?? null;
  const isPushConsumer = consumerInfo !== null && !consumerInfo.isPull;
  const refreshConsumers = (): void => {
    void qc.invalidateQueries({ queryKey: consumersKey(connId, stream ?? "") });
  };

  const [batch, setBatch] = useState(10);
  const [messages, setMessages] = useState<FetchedMessageDto[]>([]);
  const [acted, setActed] = useState<Record<number, AckAction>>({});
  const [actErrors, setActErrors] = useState<Record<number, unknown>>({});
  const [lastFetch, setLastFetch] = useState<{ requested: number; received: number } | null>(null);

  const pickStream = (v: string | null): void => {
    setPickedStream(v);
    setPickedConsumer(null);
    setLastFetch(null);
  };
  const pickConsumer = (v: string | null): void => {
    setPickedConsumer(v);
    setLastFetch(null);
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
              hint: c.isPull ? `${c.numPending} pending` : "push — can't fetch",
            }))}
            disabled={consumerList.length === 0}
            placeholder="No consumers"
          />
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

      {messages.length === 0 ? (
        isPushConsumer ? (
          <EmptyState icon="alert" title="Push consumer selected">
            “{consumer}” delivers to a subject instead of being pulled — Consumer Lab only fetches from
            pull consumers. Pick a different one, or create a pull consumer on the Consumers page.
          </EmptyState>
        ) : lastFetch !== null ? (
          <EmptyState icon="beaker" title="Fetch completed — nothing came back">
            Requested {lastFetch.requested}, received 0. Either nothing is pending right now, another
            puller already claimed it, or the wait expired before anything arrived. Safe to try again.
          </EmptyState>
        ) : consumer !== null && pending === 0 ? (
          <EmptyState icon="beaker" title="No pending messages">
            Consumer “{consumer}” has nothing waiting to pull. Publish to its stream, or pick a
            consumer that shows a pending count.
          </EmptyState>
        ) : (
          <EmptyState icon="beaker" title="No messages fetched yet">
            Pick a pull consumer with pending messages and click Fetch. (Push consumers can't be
            pulled.)
          </EmptyState>
        )
      ) : (
        <ul className="space-y-2.5">
          {messages.map((m) => (
            <MessageRow
              key={m.streamSeq}
              msg={m}
              acted={acted[m.streamSeq]}
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
  error,
  onAct,
}: {
  msg: FetchedMessageDto;
  acted: AckAction | undefined;
  error: unknown;
  onAct: (msg: FetchedMessageDto, action: AckAction) => void;
}): JSX.Element {
  return (
    <Panel className={acted ? "space-y-3 p-4 opacity-60" : "space-y-3 p-4"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone="neutral">#{msg.streamSeq}</Badge>
          <Badge tone={msg.numDelivered > 1 ? "warning" : "neutral"}>
            delivered ×{msg.numDelivered}
          </Badge>
          <span className="truncate font-mono text-sm text-content">{msg.subject}</span>
          <span className="shrink-0 tabular-nums text-faint">{msg.size} B</span>
        </div>
        {acted ? (
          <Badge tone={ACTED_TONE[acted]}>{ACTED_LABEL[acted]}</Badge>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" icon="check" onClick={() => onAct(msg, "ack")}>
              Ack
            </Button>
            <Button size="sm" variant="outline" icon="alert" onClick={() => onAct(msg, "nak")}>
              Nak
            </Button>
            <Button size="sm" variant="danger" icon="x" onClick={() => onAct(msg, "term")}>
              Term
            </Button>
          </div>
        )}
      </div>
      {error !== undefined && <ErrorNote error={error} />}
      <PayloadView view={toView(msg)} />
    </Panel>
  );
}
