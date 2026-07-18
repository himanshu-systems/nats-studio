import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ipc, PayloadEncoding } from "@bindings";
import type { FetchedMessageDto, MessageView } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, Panel, SectionLabel } from "../../components/ui";
import { PayloadView, errorMessage } from "../messaging/message";

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
  const consumerNames = (consumers.data?.consumers ?? []).map((c) => c.name);

  const [pickedConsumer, setPickedConsumer] = useState<string | null>(null);
  const consumer = pickedConsumer ?? consumerNames[0] ?? null;

  const [batch, setBatch] = useState(10);
  const [messages, setMessages] = useState<FetchedMessageDto[]>([]);
  const [acted, setActed] = useState<Record<number, AckAction>>({});

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
    publish.mutate(
      { subject: msg.ackSubject, payload: ACK_BODY[action] },
      { onSuccess: () => setActed((a) => ({ ...a, [msg.streamSeq]: action })) },
    );
  };

  return (
    <div className="mx-auto max-w-4xl space-y-3 overflow-auto p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionLabel>Consumer Lab{messages.length > 0 ? ` (${messages.length})` : ""}</SectionLabel>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="field h-8 max-w-[180px] text-xs"
            value={stream ?? ""}
            onChange={(e) => {
              setPickedStream(e.target.value);
              setPickedConsumer(null);
            }}
            disabled={streamNames.length === 0}
          >
            {streamNames.length === 0 && <option value="">No streams</option>}
            {streamNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <select
            className="field h-8 max-w-[180px] text-xs"
            value={consumer ?? ""}
            onChange={(e) => setPickedConsumer(e.target.value)}
            disabled={consumerNames.length === 0}
          >
            {consumerNames.length === 0 && <option value="">No consumers</option>}
            {consumerNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
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
            disabled={consumer === null || fetch.isPending}
          >
            {fetch.isPending ? "Fetching…" : "Fetch"}
          </Button>
        </div>
      </div>

      {streams.isError && <p className="text-xs text-danger">{errorMessage(streams.error)}</p>}
      {consumers.isError && <p className="text-xs text-danger">{errorMessage(consumers.error)}</p>}
      {fetch.isError && <p className="text-xs text-danger">{errorMessage(fetch.error)}</p>}
      {publish.isError && <p className="text-xs text-danger">{errorMessage(publish.error)}</p>}

      {messages.length === 0 ? (
        <EmptyState icon="beaker" title="No messages fetched">
          Pick a pull consumer and fetch a batch. Push consumers can't be pulled.
        </EmptyState>
      ) : (
        <ul className="space-y-2.5">
          {messages.map((m) => (
            <MessageRow key={m.streamSeq} msg={m} acted={acted[m.streamSeq]} onAct={act} />
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
  onAct,
}: {
  msg: FetchedMessageDto;
  acted: AckAction | undefined;
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
      <PayloadView view={toView(msg)} />
    </Panel>
  );
}
