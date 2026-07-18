import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@bindings";
import type { ConsumerInfoDto } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, Panel, SectionLabel } from "../../components/ui";
import { errorMessage } from "../messaging/message";

const streamsKey = (connId: string): [string, string] => ["streams", connId];
const consumersKey = (connId: string, stream: string): [string, string, string] => [
  "consumers",
  connId,
  stream,
];

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

  const [picked, setPicked] = useState<string | null>(null);
  const stream = picked ?? streamNames[0] ?? null;

  const consumers = useQuery({
    queryKey: consumersKey(connId, stream ?? ""),
    queryFn: () => ipc.jetstream.listConsumers({ connectionId: connId, streamName: stream ?? "" }),
    enabled: stream !== null,
  });

  const remove = useMutation({
    mutationFn: (name: string) =>
      ipc.jetstream.deleteConsumer({ connectionId: connId, streamName: stream ?? "", name }),
    onSettled: () => qc.invalidateQueries({ queryKey: consumersKey(connId, stream ?? "") }),
  });

  const items = consumers.data?.consumers ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-3 overflow-auto p-4">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>Consumers{stream ? ` — ${stream} (${items.length})` : ""}</SectionLabel>
        <div className="flex items-center gap-2">
          <select
            className="field h-8 max-w-[220px] text-xs"
            value={stream ?? ""}
            onChange={(e) => setPicked(e.target.value)}
            disabled={streamNames.length === 0}
          >
            {streamNames.length === 0 && <option value="">No streams</option>}
            {streamNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            icon="replay"
            onClick={() => void consumers.refetch()}
            disabled={stream === null || consumers.isFetching}
          >
            {consumers.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {streams.isError && <p className="text-xs text-danger">{errorMessage(streams.error)}</p>}
      {consumers.isError && <p className="text-xs text-danger">{errorMessage(consumers.error)}</p>}
      {remove.isError && <p className="text-xs text-danger">{errorMessage(remove.error)}</p>}

      {stream === null && !streams.isLoading ? (
        <EmptyState icon="database" title="No streams">
          Create a JetStream stream first — consumers are inspected per stream.
        </EmptyState>
      ) : items.length === 0 && !consumers.isLoading && stream !== null ? (
        <EmptyState icon="users" title="No consumers">
          Stream “{stream}” has no consumers.
        </EmptyState>
      ) : (
        <ul className="space-y-2.5">
          {items.map((c) => (
            <ConsumerCard
              key={c.name}
              info={c}
              onDelete={() => {
                if (window.confirm(`Delete consumer "${c.name}" on "${stream}"? This cannot be undone.`)) {
                  remove.mutate(c.name);
                }
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ConsumerCard({
  info,
  onDelete,
}: {
  info: ConsumerInfoDto;
  onDelete: () => void;
}): JSX.Element {
  return (
    <Panel className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-content">{info.name}</span>
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
