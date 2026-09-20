import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, StreamRetention } from "@bindings";
import type { ConsumerConfigDto, ConsumerInfoDto } from "@bindings";
import { LIST_REFETCH_MS } from "../../lib/liveEvents";
import { useUiStore } from "../../lib/uiStore";
import { RequireConnection } from "../../components/RequireConnection";
import { SplitPane } from "../../components/SplitPane";
import { Badge, Button, EmptyState, Panel, SearchInput, SectionLabel, cx } from "../../components/ui";
import { Select } from "../../components/Select";
import { Icon } from "../../components/Icon";
import { TipLabel } from "../../components/InfoTip";
import { useConfirm } from "../../components/ConfirmDialog";
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
  const openLiveTail = useUiStore((s) => s.openLiveTail);
  const streams = useQuery({
    queryKey: streamsKey(connId),
    queryFn: () => ipc.jetstream.listStreams({ connectionId: connId }),
    refetchInterval: LIST_REFETCH_MS,
  });
  const streamList = streams.data?.streams ?? [];
  const streamNames = streamList.map((s) => s.config.name);

  // JetStream's own API only lists consumers per stream (no "all consumers"
  // endpoint) — fan out one query per stream and merge, so this reads like
  // Streams: every consumer, across every stream, in one flat list.
  const consumerQueries = useQueries({
    queries: streamNames.map((name) => ({
      queryKey: consumersKey(connId, name),
      queryFn: () => ipc.jetstream.listConsumers({ connectionId: connId, streamName: name }),
      refetchInterval: LIST_REFETCH_MS,
    })),
  });
  const allConsumers: StreamConsumer[] = streamNames.flatMap(
    (stream, i) => (consumerQueries[i]?.data?.consumers ?? []).map((info) => ({ stream, info })),
  );
  const consumersLoading = streams.isLoading || consumerQueries.some((q) => q.isLoading);
  const consumersFetching = streams.isFetching || consumerQueries.some((q) => q.isFetching);
  const firstConsumerError = consumerQueries.find((q) => q.isError)?.error;
  const refetchAll = (): void => {
    void streams.refetch();
    consumerQueries.forEach((q) => void q.refetch());
  };

  const remove = useMutation({
    mutationFn: ({ stream, name }: { stream: string; name: string }) =>
      ipc.jetstream.deleteConsumer({ connectionId: connId, streamName: stream, name }),
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: consumersKey(connId, vars.stream) });
      void qc.invalidateQueries({ queryKey: streamsKey(connId) });
    },
  });

  const confirm = useConfirm();
  const confirmDelete = (stream: string, info: ConsumerInfoDto): void => {
    void confirm({
      title: `Delete consumer "${info.name}"?`,
      description: `On stream "${stream}". This cannot be undone.`,
      consequences: [
        (info.numPending ?? 0) > 0
          ? `${(info.numPending ?? 0).toLocaleString()} pending message(s) will stop being delivered to it.`
          : "Any messages published after this will never reach it.",
        "Anything relying on its delivery/ack progress will lose that state.",
      ],
      confirmLabel: "Delete consumer",
      confirmIcon: "x",
    }).then((ok) => {
      if (ok) remove.mutate({ stream, name: info.name });
    });
  };

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

  // Group by the subject each consumer filters on — the same flat data, just
  // organized by "who's listening to what" instead of one long list.
  // Consumers with no filter (listening to every subject in the stream) get
  // their own bucket, sorted last.
  const [groupBy, setGroupBy] = useState<"none" | "subject">("none");
  const bySubject = useMemo(() => {
    const groups = new Map<string, StreamConsumer[]>();
    for (const c of filtered) {
      const key = c.info.filterSubject?.trim() || "";
      const arr = groups.get(key);
      if (arr) arr.push(c);
      else groups.set(key, [c]);
    }
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === "" || b === "") return a === b ? 0 : a === "" ? 1 : -1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  return (
    <SplitPane id="consumers" className="h-full gap-4 p-4" initial={70} min={40} max={85} stackBelow={1024}>
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionLabel>
            Consumers ({filtered.length}
            {needle && ` / ${allConsumers.length}`})
          </SectionLabel>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5">
              {(
                [
                  ["none", "All"],
                  ["subject", "By subject"],
                ] as [typeof groupBy, string][]
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setGroupBy(mode)}
                  className={cx(
                    "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                    groupBy === mode ? "bg-accent text-accent-content shadow-sm" : "text-muted hover:text-content",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              icon="replay"
              iconClassName={consumersFetching ? "animate-spin" : undefined}
              onClick={refetchAll}
              disabled={consumersFetching}
            >
              {consumersFetching ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
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
        ) : groupBy === "none" ? (
          <ul className="space-y-2.5">
            {filtered.map(({ stream, info }) => (
              <ConsumerCard
                key={`${stream}::${info.name}`}
                stream={stream}
                info={info}
                onDelete={() => confirmDelete(stream, info)}
                openLiveTail={openLiveTail}
              />
            ))}
          </ul>
        ) : (
          <div className="space-y-4">
            {bySubject.map(([subject, items]) => (
              <div key={subject || "__all_subjects__"}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="font-mono text-xs text-content">{subject || "(all subjects)"}</span>
                  <Badge tone="neutral">{items.length}</Badge>
                </div>
                <ul className="space-y-2.5">
                  {items.map(({ stream, info }) => (
                    <ConsumerCard
                      key={`${stream}::${info.name}`}
                      stream={stream}
                      info={info}
                      onDelete={() => confirmDelete(stream, info)}
                      openLiveTail={openLiveTail}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      <CreateConsumerForm
        connId={connId}
        streams={streamList.map((s) => ({ name: s.config.name, retention: s.config.retention, subjects: s.config.subjects }))}
      />
    </SplitPane>
  );
}

/** Parse an optional positive integer field; blank / non-positive -> undefined. */
function parseOptInt(raw: string): number | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Could some concrete subject match both `a` and `b`? Used to warn when a
 *  consumer's filter subject doesn't overlap with anything the stream actually
 *  carries — it'll create fine but silently never receive a message.
 *  ponytail: treats `>` as "overlaps from here on" without checking that at
 *  least one token remains on the other side (the true NATS rule) — a soft
 *  heads-up, not a validator, so that corner case just means an occasional
 *  missed warning, never a false one. */
export function subjectsOverlap(a: string, b: string): boolean {
  const at = a.split(".");
  const bt = b.split(".");
  const n = Math.max(at.length, bt.length);
  for (let i = 0; i < n; i++) {
    const x = at[i];
    const y = bt[i];
    if (x === ">" || y === ">") return true;
    if (x === undefined || y === undefined) return false;
    if (x !== "*" && y !== "*" && x !== y) return false;
  }
  return true;
}

function CreateConsumerForm({
  connId,
  streams,
}: {
  connId: string;
  streams: { name: string; retention: StreamRetention; subjects: string[] }[];
}): JSX.Element {
  const qc = useQueryClient();
  const streamNames = streams.map((s) => s.name);
  const [pickedStream, setPickedStream] = useState<string | null>(null);
  const stream = pickedStream ?? streamNames[0] ?? null;
  const streamSubjects = streams.find((s) => s.name === stream)?.subjects ?? [];
  // Work Queue streams enforce "exactly one consumer per message": the server
  // rejects any ack policy but explicit, and rejects overlapping consumers.
  // Force explicit ack here so that specific rejection can't happen — the
  // "only one consumer / non-overlapping filters" rule still comes from the
  // server, since it depends on what else already exists on the stream.
  const isWorkQueue = streams.find((s) => s.name === stream)?.retention === StreamRetention.WorkQueue;

  const [consumerType, setConsumerType] = useState<"pull" | "push">("pull");
  const [durableName, setDurableName] = useState("");
  const [filterSubject, setFilterSubject] = useState("");
  const [ackPolicy, setAckPolicy] = useState("explicit");
  const [deliverPolicy, setDeliverPolicy] = useState("all");
  const [startSeq, setStartSeq] = useState("");
  const [startTime, setStartTime] = useState("");
  const [deliverSubject, setDeliverSubject] = useState("");
  const [deliverGroup, setDeliverGroup] = useState("");
  const [maxDeliver, setMaxDeliver] = useState("");
  const [ackWaitSec, setAckWaitSec] = useState("");
  const effectiveAckPolicy = isWorkQueue ? "explicit" : ackPolicy;

  // Doesn't overlap anything the stream carries -> the consumer creates fine
  // but will never receive a message. Flag it, don't block it (the filter
  // might target subjects the stream just hasn't seen yet).
  const filterTrimmed = filterSubject.trim();
  const filterMismatch =
    filterTrimmed !== "" && streamSubjects.length > 0 && !streamSubjects.some((s) => subjectsOverlap(s, filterTrimmed));

  // Unlike the filter mismatch above, this one IS always wrong, not just
  // maybe: a push consumer delivering back into a subject its own stream
  // captures is a delivery loop, and the server unconditionally rejects it
  // ("consumer deliver subject forms a cycle") — verified live against a real
  // server, not just read off the docs. Block submit instead of warning.
  const deliverSubjectTrimmed = deliverSubject.trim();
  const deliverSubjectCycle =
    consumerType === "push" &&
    deliverSubjectTrimmed !== "" &&
    streamSubjects.some((s) => subjectsOverlap(s, deliverSubjectTrimmed));

  const create = useMutation({
    mutationFn: (config: ConsumerConfigDto) =>
      ipc.jetstream.createConsumer({ connectionId: connId, streamName: stream ?? "", config }),
    onSuccess: () => {
      setDurableName("");
      setFilterSubject("");
      setStartSeq("");
      setStartTime("");
      setDeliverSubject("");
      setDeliverGroup("");
      setMaxDeliver("");
      setAckWaitSec("");
      void qc.invalidateQueries({ queryKey: consumersKey(connId, stream ?? "") });
      void qc.invalidateQueries({ queryKey: streamsKey(connId) });
    },
  });

  const submit = (): void => {
    const filter = filterSubject.trim();
    const config: ConsumerConfigDto = {
      durableName: durableName.trim(),
      filterSubject: filter === "" ? undefined : filter,
      ackPolicy: effectiveAckPolicy,
      deliverPolicy,
      optStartSeq: deliverPolicy === "byStartSequence" ? parseOptInt(startSeq) : undefined,
      // <input type="datetime-local"> has no timezone — treat it as local time.
      optStartTime:
        deliverPolicy === "byStartTime" && startTime !== ""
          ? new Date(startTime).toISOString()
          : undefined,
      deliverSubject: consumerType === "push" ? deliverSubject.trim() : undefined,
      deliverGroup: consumerType === "push" && deliverGroup.trim() !== "" ? deliverGroup.trim() : undefined,
      maxDeliver: parseOptInt(maxDeliver),
      ackWaitSeconds: parseOptInt(ackWaitSec),
    };
    create.mutate(config);
  };

  const canSubmit =
    stream !== null &&
    durableName.trim() !== "" &&
    !create.isPending &&
    (deliverPolicy !== "byStartSequence" || parseOptInt(startSeq) !== undefined) &&
    (deliverPolicy !== "byStartTime" || startTime !== "") &&
    (consumerType !== "push" || deliverSubject.trim() !== "") &&
    !deliverSubjectCycle;

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
        <TipLabel tip="Pull: the client fetches batches on demand (Consumer Lab) — good for workers processing at their own pace. Push: the server delivers messages to a subject as they arrive — watch it with Live Tail, like a live subscription with JetStream's durability/replay on top.">
          Consumer type
        </TipLabel>
        <Select
          value={consumerType}
          onChange={(v) => setConsumerType(v as "pull" | "push")}
          options={[
            { value: "pull", label: "Pull — fetch batches on demand" },
            { value: "push", label: "Push — server delivers to a subject" },
          ]}
        />
      </label>
      {consumerType === "push" && (
        <>
          <label className="block space-y-1.5">
            <TipLabel tip="The subject the server delivers messages to as they arrive. Subscribe to this exact subject in Live Tail to watch them. Must NOT overlap this stream's own subjects — delivering back into a subject the stream captures is a loop, and the server rejects it.">
              Deliver subject
            </TipLabel>
            <input
              className="field font-mono"
              value={deliverSubject}
              onChange={(e) => setDeliverSubject(e.target.value)}
              placeholder="orders.pushed"
            />
            {deliverSubjectCycle && (
              <p className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[11px] text-content">
                <span className="font-medium">Not allowed:</span> "{deliverSubjectTrimmed}" overlaps this stream's own
                subjects ({streamSubjects.join(", ")}) — delivering back into a subject the stream captures forms a
                loop. The server rejects this outright; pick a deliver subject outside the stream's subject space.
              </p>
            )}
          </label>
          <label className="block space-y-1.5">
            <TipLabel tip="Optional: share this consumer across multiple subscribers to the deliver subject — the server load-balances between them instead of delivering to all of them.">
              Queue group (optional)
            </TipLabel>
            <input
              className="field font-mono"
              value={deliverGroup}
              onChange={(e) => setDeliverGroup(e.target.value)}
              placeholder="workers"
            />
          </label>
        </>
      )}
      {isWorkQueue && (
        <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[11px] text-content">
          <span className="font-medium">Work Queue stream:</span> each message goes to exactly one
          consumer. Ack policy is forced to Explicit. If another consumer already covers these
          subjects, creation will still be rejected by the server — use a non-overlapping filter
          subject or reuse the existing consumer.
        </p>
      )}
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
        {filterMismatch && (
          <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[11px] text-content">
            <span className="font-medium">Heads up:</span> "{filterTrimmed}" doesn't match any of this stream's
            subjects ({streamSubjects.join(", ")}). It'll create fine but never receive anything until you fix the
            filter — this is a NATS quirk: mismatched filters aren't rejected at creation time.
          </p>
        )}
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1.5">
          <TipLabel
            tip={
              isWorkQueue
                ? "Work Queue streams require Explicit ack — locked for this stream."
                : "How messages must be acknowledged. Explicit = ack each one (needed for retries/redelivery). All = an ack confirms all prior. None = no acks (fire-and-forget)."
            }
          >
            Ack policy
          </TipLabel>
          <Select
            value={effectiveAckPolicy}
            onChange={setAckPolicy}
            disabled={isWorkQueue}
            options={[
              { value: "explicit", label: "Explicit" },
              { value: "all", label: "All" },
              { value: "none", label: "None" },
            ]}
          />
        </label>
        <label className="block space-y-1.5">
          <TipLabel tip="Where delivery starts. All = from the first message (replay the whole stream). New = only messages arriving from now. Last = start at the last message. Last per subject = the newest message of each subject. From sequence / From time = replay starting at a specific point in the stream's history.">
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
              { value: "byStartSequence", label: "From sequence" },
              { value: "byStartTime", label: "From time" },
            ]}
          />
        </label>
      </div>
      {deliverPolicy === "byStartSequence" && (
        <label className="block space-y-1.5">
          <TipLabel tip="Replay starts at this stream sequence number (inclusive) and delivers forward from there, like it's live traffic. Pair with Consumer Lab's batch size to bound how far you pull — e.g. start at 233 and fetch a batch of ~4767 to land around seq 5000.">
            Start sequence
          </TipLabel>
          <input
            className="field tabular-nums"
            value={startSeq}
            onChange={(e) => setStartSeq(e.target.value)}
            placeholder="233"
            inputMode="numeric"
          />
        </label>
      )}
      {deliverPolicy === "byStartTime" && (
        <label className="block space-y-1.5">
          <TipLabel tip="Replay starts at the first message timestamped at or after this moment (your local timezone) and delivers forward from there.">
            Start time
          </TipLabel>
          <input
            type="datetime-local"
            className="field tabular-nums"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
          />
        </label>
      )}
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
  openLiveTail,
}: {
  stream: string;
  info: ConsumerInfoDto;
  onDelete: () => void;
  openLiveTail: (subject: string) => void;
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
            <Badge tone={info.isPull ? "neutral" : "accent"}>{info.isPull ? "Pull" : "Push"}</Badge>
            <Badge tone="neutral">deliver: {info.deliverPolicy}</Badge>
            <Badge tone="neutral">ack: {info.ackPolicy}</Badge>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-muted">
            {info.filterSubject ? info.filterSubject : "(all subjects)"}
          </div>
          {info.deliverSubject && (
            <button
              type="button"
              onClick={() => openLiveTail(info.deliverSubject!)}
              className="mt-0.5 flex max-w-full items-center gap-1 truncate font-mono text-[11px] text-faint transition-colors hover:text-accent"
              title={`Watch ${info.deliverSubject} in Live Tail`}
            >
              <Icon name="signal" size={11} className="shrink-0" />
              <span className="truncate">delivers to: {info.deliverSubject}</span>
            </button>
          )}
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
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-xs sm:grid-cols-5">
        <Metric label="Pending" value={(info.numPending ?? 0).toLocaleString()} />
        <Metric label="Ack pending" value={(info.numAckPending ?? 0).toLocaleString()} />
        <Metric label="Redelivered" value={(info.numRedelivered ?? 0).toLocaleString()} />
        <Metric label="Ack floor" value={`#${(info.ackFloorStreamSeq ?? 0).toLocaleString()}`} />
        <Metric label="Last delivered" value={`#${(info.deliveredStreamSeq ?? 0).toLocaleString()}`} />
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
