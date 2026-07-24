import { useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@bindings";
import type { ConsumerConfigDto, ConsumerInfoDto } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, Panel, SearchInput, SectionLabel } from "../../components/ui";
import { Select } from "../../components/Select";
import { TipLabel } from "../../components/InfoTip";
import { errorMessage } from "../messaging/message";

const streamsKey = (connId: string): [string, string] => ["streams", connId];
const consumersKey = (connId: string, stream: string): [string, string, string] => [
  "consumers",
  connId,
  stream,
];

interface StreamConsumer {
  stream: string;
  info: ConsumerInfoDto;
}

export function ConsumersView(): JSX.Element {
  return <RequireConnection>{(connId) => <Consumers connId={connId} />}</RequireConnection>;
}

function Consumers({ connId }: { connId: string }): JSX.Element {
  const qc = useQueryClient();
  const streams = useQuery({
    queryKey: streamsKey(connId),
    queryFn: () => ipc.jetstream.listStreams({ connectionId: connId }),
  });
  const streamNames = (streams.data?.streams ?? []).map((s) => s.config.name);

  // JetStream's own API only lists consumers per stream (no "all consumers"
  // endpoint) — fan out one query per stream and merge, so this reads like
  // Streams: every consumer, across every stream, in one flat list.
  const consumerQueries = useQueries({
    queries: streamNames.map((name) => ({
      queryKey: consumersKey(connId, name),
      queryFn: () => ipc.jetstream.listConsumers({ connectionId: connId, streamName: name }),
    })),
  });
  const allConsumers: StreamConsumer[] = streamNames.flatMap(
    (stream, i) => (consumerQueries[i]?.data?.consumers ?? []).map((info) => ({ stream, info })),
  );
  const consumersLoading = streams.isLoading || consumerQueries.some((q) => q.isLoading);
  const consumersFetching = consumerQueries.some((q) => q.isFetching);
  const firstConsumerError = consumerQueries.find((q) => q.isError)?.error;
  const refetchAll = (): void => {
    consumerQueries.forEach((q) => void q.refetch());
  };

  const remove = useMutation({
    mutationFn: ({ stream, name }: { stream: string; name: string }) =>
      ipc.jetstream.deleteConsumer({ connectionId: connId, streamName: stream, name }),
    onSettled: (_data, _err, vars) => qc.invalidateQueries({ queryKey: consumersKey(connId, vars.stream) }),
  });

  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const filtered =
    needle === ""
      ? allConsumers
      : allConsumers.filter(
          ({ stream, info }) =>
            info.name.toLowerCase().includes(needle) ||
            (info.filterSubject ?? "").toLowerCase().includes(needle) ||
            stream.toLowerCase().includes(needle),
        );

  return (
    <div className="grid h-full grid-rows-[1fr] gap-4 overflow-auto p-4 lg:grid-cols-[1fr_320px]">
      <div className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>
            Consumers ({filtered.length}
            {needle && ` / ${allConsumers.length}`})
          </SectionLabel>
          <Button
            size="sm"
            variant="outline"
            icon="replay"
            onClick={refetchAll}
            disabled={streamNames.length === 0 || consumersFetching}
          >
            {consumersFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>

        {allConsumers.length > 0 && (
          <SearchInput value={q} onChange={setQ} placeholder="Search consumer, subject, or stream…" />
        )}

        {streams.isError && <p className="text-xs text-danger">{errorMessage(streams.error)}</p>}
        {firstConsumerError && <p className="text-xs text-danger">{errorMessage(firstConsumerError)}</p>}
        {remove.isError && <p className="text-xs text-danger">{errorMessage(remove.error)}</p>}

        {streamNames.length === 0 && !streams.isLoading ? (
          <EmptyState icon="database" title="No streams">
            Create a JetStream stream first — consumers belong to a stream.
          </EmptyState>
        ) : allConsumers.length === 0 && !consumersLoading ? (
          <EmptyState icon="users" title="No consumers">
            No stream has any consumers yet. Create one with the form on the right.
          </EmptyState>
        ) : filtered.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted">No consumers match “{q}”.</p>
        ) : (
          <ul className="space-y-2.5">
            {filtered.map(({ stream, info }) => (
              <ConsumerCard
                key={`${stream}::${info.name}`}
                stream={stream}
                info={info}
                onDelete={() => {
                  if (window.confirm(`Delete consumer "${info.name}" on "${stream}"? This cannot be undone.`)) {
                    remove.mutate({ stream, name: info.name });
                  }
                }}
              />
            ))}
          </ul>
        )}
      </div>

      <CreateConsumerForm connId={connId} streamNames={streamNames} />
    </div>
  );
}

/** Parse an optional positive integer field; blank / non-positive -> undefined. */
function parseOptInt(raw: string): number | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function CreateConsumerForm({
  connId,
  streamNames,
}: {
  connId: string;
  streamNames: string[];
}): JSX.Element {
  const qc = useQueryClient();
  const [pickedStream, setPickedStream] = useState<string | null>(null);
  const stream = pickedStream ?? streamNames[0] ?? null;
  const [durableName, setDurableName] = useState("");
  const [filterSubject, setFilterSubject] = useState("");
  const [ackPolicy, setAckPolicy] = useState("explicit");
  const [deliverPolicy, setDeliverPolicy] = useState("all");
  const [maxDeliver, setMaxDeliver] = useState("");
  const [ackWaitSec, setAckWaitSec] = useState("");

  const create = useMutation({
    mutationFn: (config: ConsumerConfigDto) =>
      ipc.jetstream.createConsumer({ connectionId: connId, streamName: stream ?? "", config }),
    onSuccess: () => {
      setDurableName("");
      setFilterSubject("");
      setMaxDeliver("");
      setAckWaitSec("");
      void qc.invalidateQueries({ queryKey: consumersKey(connId, stream ?? "") });
    },
  });

  const submit = (): void => {
    const filter = filterSubject.trim();
    const config: ConsumerConfigDto = {
      durableName: durableName.trim(),
      filterSubject: filter === "" ? undefined : filter,
      ackPolicy,
      deliverPolicy,
      maxDeliver: parseOptInt(maxDeliver),
      ackWaitSeconds: parseOptInt(ackWaitSec),
    };
    create.mutate(config);
  };

  const canSubmit = stream !== null && durableName.trim() !== "" && !create.isPending;

  return (
    <Panel className="h-fit space-y-3 p-4">
      <SectionLabel>Create consumer</SectionLabel>
      <label className="block space-y-1.5">
        <TipLabel tip="Which stream this consumer reads from.">Stream</TipLabel>
        <Select
          value={stream ?? ""}
          onChange={setPickedStream}
          options={streamNames.map((n) => ({ value: n, label: n }))}
          disabled={streamNames.length === 0}
          placeholder="No streams"
        />
      </label>
      <label className="block space-y-1.5">
        <TipLabel tip="Durable name — a persistent consumer that survives restarts and remembers its position. Pull it from Consumer Lab by this name.">
          Durable name
        </TipLabel>
        <input
          className="field"
          value={durableName}
          onChange={(e) => setDurableName(e.target.value)}
          placeholder="worker"
        />
      </label>
      <label className="block space-y-1.5">
        <TipLabel tip="Only receive messages whose subject matches this filter (a subset of the stream's subjects). Blank = all subjects in the stream. Wildcards * and > allowed.">
          Filter subject (optional)
        </TipLabel>
        <input
          className="field font-mono"
          value={filterSubject}
          onChange={(e) => setFilterSubject(e.target.value)}
          placeholder="orders.>"
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1.5">
          <TipLabel tip="How messages must be acknowledged. Explicit = ack each one (needed for retries/redelivery). All = an ack confirms all prior. None = no acks (fire-and-forget).">
            Ack policy
          </TipLabel>
          <Select
            value={ackPolicy}
            onChange={setAckPolicy}
            options={[
              { value: "explicit", label: "Explicit" },
              { value: "all", label: "All" },
              { value: "none", label: "None" },
            ]}
          />
        </label>
        <label className="block space-y-1.5">
          <TipLabel tip="Where delivery starts. All = from the first message. New = only messages arriving from now. Last = start at the last message. Last per subject = the newest message of each subject.">
            Deliver policy
          </TipLabel>
          <Select
            value={deliverPolicy}
            onChange={setDeliverPolicy}
            options={[
              { value: "all", label: "All" },
              { value: "last", label: "Last" },
              { value: "new", label: "New" },
              { value: "lastPerSubject", label: "Last per subject" },
            ]}
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1.5">
          <TipLabel tip="Max redelivery attempts before a message is considered failed (and a poison advisory fires — see Dead Letters). Blank = unlimited (∞).">
            Max deliver
          </TipLabel>
          <input
            className="field tabular-nums"
            value={maxDeliver}
            onChange={(e) => setMaxDeliver(e.target.value)}
            placeholder="∞"
            inputMode="numeric"
          />
        </label>
        <label className="block space-y-1.5">
          <TipLabel tip="How long the server waits for an ack before redelivering the message (seconds). Blank = server default (30s).">
            Ack wait (s)
          </TipLabel>
          <input
            className="field tabular-nums"
            value={ackWaitSec}
            onChange={(e) => setAckWaitSec(e.target.value)}
            placeholder="default"
            inputMode="numeric"
          />
        </label>
      </div>
      <Button icon="plus" className="w-full" onClick={submit} disabled={!canSubmit}>
        {create.isPending ? "Creating…" : "Create consumer"}
      </Button>
      {create.isError && <p className="text-xs text-danger">{errorMessage(create.error)}</p>}
    </Panel>
  );
}

function ConsumerCard({
  stream,
  info,
  onDelete,
}: {
  stream: string;
  info: ConsumerInfoDto;
  onDelete: () => void;
}): JSX.Element {
  return (
    <Panel className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-content">{info.name}</span>
            <Badge tone="accent">{stream}</Badge>
            <Badge tone={info.durableName ? "accent" : "neutral"}>
              {info.durableName ? "Durable" : "Ephemeral"}
            </Badge>
            <Badge tone="neutral">deliver: {info.deliverPolicy}</Badge>
            <Badge tone="neutral">ack: {info.ackPolicy}</Badge>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-muted">
            {info.filterSubject ? info.filterSubject : "(all subjects)"}
          </div>
        </div>
        <Button
          size="sm"
          variant="danger"
          icon="x"
          onClick={onDelete}
          aria-label="Delete consumer"
          className="shrink-0"
        />
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-x-4 gap-y-1 border-t border-border/60 pt-3 text-xs">
        <Metric label="Pending" value={info.numPending.toLocaleString()} />
        <Metric label="Ack pending" value={info.numAckPending.toLocaleString()} />
        <Metric label="Redelivered" value={info.numRedelivered.toLocaleString()} />
      </dl>
    </Panel>
  );
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate font-medium tabular-nums text-content">{value}</dd>
    </div>
  );
}
