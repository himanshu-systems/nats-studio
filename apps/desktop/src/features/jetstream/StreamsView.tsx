import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, StreamDiscard, StreamRetention, StreamStorage } from "@bindings";
import type { StreamConfigDto, StreamInfoDto } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, Panel, SearchInput, SectionLabel, cx } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { Select } from "../../components/Select";
import { errorMessage } from "../messaging/message";

const streamsKey = (connId: string): [string, string] => ["streams", connId];

/** Format a byte count with binary units. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Parse an optional positive integer field; blank / non-positive -> undefined. */
function parseOptInt(raw: string): number | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Split a comma / newline separated subjects field into a clean list. */
function parseSubjects(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function StreamsView(): JSX.Element {
  return <RequireConnection>{(connId) => <Streams connId={connId} />}</RequireConnection>;
}

function Streams({ connId }: { connId: string }): JSX.Element {
  const qc = useQueryClient();
  const streams = useQuery({
    queryKey: streamsKey(connId),
    queryFn: () => ipc.jetstream.listStreams({ connectionId: connId }),
  });

  const remove = useMutation({
    mutationFn: (name: string) => ipc.jetstream.deleteStream({ connectionId: connId, name }),
    onSettled: () => qc.invalidateQueries({ queryKey: streamsKey(connId) }),
  });

  const [purgeTarget, setPurgeTarget] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const items = streams.data?.streams ?? [];
  const needle = q.trim().toLowerCase();
  const filtered =
    needle === ""
      ? items
      : items.filter(
          (s) =>
            s.config.name.toLowerCase().includes(needle) ||
            s.config.subjects.some((subj) => subj.toLowerCase().includes(needle)),
        );

  return (
    <div className="mx-auto grid h-full max-w-6xl grid-rows-[1fr] gap-4 overflow-auto p-4 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>
            Streams ({filtered.length}
            {needle && ` / ${items.length}`})
          </SectionLabel>
          <Button
            size="sm"
            variant="outline"
            icon="replay"
            onClick={() => void streams.refetch()}
            disabled={streams.isFetching}
          >
            {streams.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        <SearchInput value={q} onChange={setQ} placeholder="Search name or subject…" />

        {streams.isError && (
          <p className="text-xs text-danger">{errorMessage(streams.error)}</p>
        )}

        {items.length === 0 && !streams.isLoading ? (
          <EmptyState icon="database" title="No streams">
            This account has no JetStream streams yet. Create one with the form on the right.
          </EmptyState>
        ) : filtered.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted">No streams match “{q}”.</p>
        ) : (
          <ul className="space-y-2.5">
            {filtered.map((s) => (
              <StreamCard
                key={s.config.name}
                info={s}
                onDelete={() => {
                  if (window.confirm(`Delete stream "${s.config.name}"? This cannot be undone.`)) {
                    remove.mutate(s.config.name);
                  }
                }}
                onPurge={() => setPurgeTarget(s.config.name)}
              />
            ))}
          </ul>
        )}
        {remove.isError && <p className="text-xs text-danger">{errorMessage(remove.error)}</p>}
      </div>

      <CreateStreamForm connId={connId} />

      {purgeTarget !== null && (
        <PurgeModal
          connId={connId}
          name={purgeTarget}
          onClose={() => setPurgeTarget(null)}
          onDone={() => {
            setPurgeTarget(null);
            void qc.invalidateQueries({ queryKey: streamsKey(connId) });
          }}
        />
      )}
    </div>
  );
}

function StreamCard({
  info,
  onDelete,
  onPurge,
}: {
  info: StreamInfoDto;
  onDelete: () => void;
  onPurge: () => void;
}): JSX.Element {
  const { config, state } = info;
  return (
    <Panel className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-content">{config.name}</span>
            <Badge tone={config.storage === StreamStorage.Memory ? "warning" : "neutral"}>
              {config.storage === StreamStorage.Memory ? "Memory" : "File"}
            </Badge>
            <Badge tone="accent">{config.retention}</Badge>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-muted">
            {config.subjects.length > 0 ? config.subjects.join(", ") : "(no subjects)"}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="outline" icon="trash" onClick={onPurge}>
            Purge
          </Button>
          <Button size="sm" variant="danger" icon="x" onClick={onDelete} aria-label="Delete stream" />
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-4 gap-x-4 gap-y-1 border-t border-border/60 pt-3 text-xs">
        <Metric label="Messages" value={state.messages.toLocaleString()} />
        <Metric label="Bytes" value={fmtBytes(state.bytes)} />
        <Metric label="Subjects" value={state.numSubjects.toLocaleString()} />
        <Metric label="Consumers" value={state.consumerCount.toLocaleString()} />
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

function CreateStreamForm({ connId }: { connId: string }): JSX.Element {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [subjectsRaw, setSubjectsRaw] = useState("");
  const [storage, setStorage] = useState<StreamStorage>(StreamStorage.File);
  const [retention, setRetention] = useState<StreamRetention>(StreamRetention.Limits);
  const [maxMessages, setMaxMessages] = useState("");
  const [maxBytes, setMaxBytes] = useState("");
  const [maxAgeSec, setMaxAgeSec] = useState("");

  const create = useMutation({
    mutationFn: (config: StreamConfigDto) =>
      ipc.jetstream.createStream({ connectionId: connId, config }),
    onSuccess: () => {
      setName("");
      setSubjectsRaw("");
      setMaxMessages("");
      setMaxBytes("");
      setMaxAgeSec("");
      void qc.invalidateQueries({ queryKey: streamsKey(connId) });
    },
  });

  const subjects = parseSubjects(subjectsRaw);
  const ageSec = parseOptInt(maxAgeSec);

  const submit = (): void => {
    const config: StreamConfigDto = {
      name: name.trim(),
      subjects,
      storage,
      retention,
      discard: StreamDiscard.Old,
      maxMessages: parseOptInt(maxMessages),
      maxBytes: parseOptInt(maxBytes),
      maxAgeMs: ageSec === undefined ? undefined : ageSec * 1000,
      maxMessageSize: undefined,
      numReplicas: 1,
      duplicateWindowMs: undefined,
      description: undefined,
    };
    create.mutate(config);
  };

  const canSubmit = name.trim() !== "" && subjects.length > 0 && !create.isPending;

  return (
    <Panel className="h-fit space-y-3 p-4">
      <SectionLabel>Create stream</SectionLabel>
      <label className="block space-y-1.5">
        <span className="text-[11px] text-muted">Name</span>
        <input
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ORDERS"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[11px] text-muted">Subjects (comma or newline separated)</span>
        <span className="block text-[11px] leading-tight text-faint">
          Which subjects this stream captures. Wildcards: <code className="font-mono">*</code> = one
          token, <code className="font-mono">&gt;</code> = the rest (e.g. <code className="font-mono">orders.&gt;</code>).
        </span>
        <textarea
          className="field-mono min-h-[64px]"
          value={subjectsRaw}
          onChange={(e) => setSubjectsRaw(e.target.value)}
          placeholder={"orders.>\norders.eu.*"}
          spellCheck={false}
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1.5">
          <span className="text-[11px] text-muted">Storage</span>
          <Select
            value={storage}
            onChange={(v) => setStorage(v as StreamStorage)}
            options={[
              { value: StreamStorage.File, label: "File" },
              { value: StreamStorage.Memory, label: "Memory" },
            ]}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[11px] text-muted">Retention</span>
          <Select
            value={retention}
            onChange={(v) => setRetention(v as StreamRetention)}
            options={[
              { value: StreamRetention.Limits, label: "Limits" },
              { value: StreamRetention.Interest, label: "Interest" },
              { value: StreamRetention.WorkQueue, label: "Work Queue" },
            ]}
          />
        </label>
      </div>
      <ul className="space-y-1 rounded-lg border border-border bg-surface-2 p-2.5 text-[11px] leading-tight text-muted">
        <li>
          <span className="font-medium text-content">Storage</span> — File: durable on disk · Memory:
          fast, cleared on server restart.
        </li>
        <li>
          <span className="font-medium text-content">Retention</span> — Limits: keep until a max
          below is hit · Interest: keep only while a consumer is subscribed · Work Queue: each message
          goes to exactly one consumer, then is removed.
        </li>
      </ul>
      <div className="grid grid-cols-3 gap-3">
        <label className="block space-y-1.5">
          <span className="text-[11px] text-muted">Max msgs</span>
          <input
            className="field tabular-nums"
            value={maxMessages}
            onChange={(e) => setMaxMessages(e.target.value)}
            placeholder="∞"
            inputMode="numeric"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[11px] text-muted">Max bytes</span>
          <input
            className="field tabular-nums"
            value={maxBytes}
            onChange={(e) => setMaxBytes(e.target.value)}
            placeholder="∞"
            inputMode="numeric"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[11px] text-muted">Max age (s)</span>
          <input
            className="field tabular-nums"
            value={maxAgeSec}
            onChange={(e) => setMaxAgeSec(e.target.value)}
            placeholder="∞"
            inputMode="numeric"
          />
        </label>
      </div>
      <Button icon="plus" className="w-full" onClick={submit} disabled={!canSubmit}>
        {create.isPending ? "Creating…" : "Create stream"}
      </Button>
      {create.isError && <p className="text-xs text-danger">{errorMessage(create.error)}</p>}
    </Panel>
  );
}

type PurgeMode = "all" | "subject" | "keep" | "seq";

function PurgeModal({
  connId,
  name,
  onClose,
  onDone,
}: {
  connId: string;
  name: string;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<PurgeMode>("all");
  const [subject, setSubject] = useState("");
  const [keep, setKeep] = useState("");
  const [seq, setSeq] = useState("");

  const purge = useMutation({
    mutationFn: () =>
      ipc.jetstream.purgeStream({
        connectionId: connId,
        name,
        filter: mode === "subject" ? subject.trim() || undefined : undefined,
        keep: mode === "keep" ? parseOptInt(keep) : undefined,
        upToSeq: mode === "seq" ? parseOptInt(seq) : undefined,
      }),
    onSuccess: () => onDone(),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <Panel className="w-full max-w-sm space-y-3 p-4">
        <div onClick={(e) => e.stopPropagation()} className="space-y-3">
          <div className="flex items-center justify-between">
            <SectionLabel>Purge “{name}”</SectionLabel>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-content"
            >
              <Icon name="x" size={16} />
            </button>
          </div>

          <div className="space-y-1.5">
            {(
              [
                ["all", "Purge all messages"],
                ["subject", "By subject filter"],
                ["keep", "Keep N newest"],
                ["seq", "Up to sequence"],
              ] as [PurgeMode, string][]
            ).map(([m, label]) => (
              <label
                key={m}
                className={cx(
                  "flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-xs",
                  mode === m ? "border-accent/40 bg-accent/10 text-content" : "border-border text-muted",
                )}
              >
                <input
                  type="radio"
                  name="purge-mode"
                  checked={mode === m}
                  onChange={() => setMode(m)}
                />
                {label}
              </label>
            ))}
          </div>

          {mode === "subject" && (
            <input
              className="field font-mono"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="orders.eu.*"
            />
          )}
          {mode === "keep" && (
            <input
              className="field tabular-nums"
              value={keep}
              onChange={(e) => setKeep(e.target.value)}
              placeholder="100"
              inputMode="numeric"
            />
          )}
          {mode === "seq" && (
            <input
              className="field tabular-nums"
              value={seq}
              onChange={(e) => setSeq(e.target.value)}
              placeholder="5000"
              inputMode="numeric"
            />
          )}

          {purge.isError && <p className="text-xs text-danger">{errorMessage(purge.error)}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon="trash"
              onClick={() => purge.mutate()}
              disabled={purge.isPending}
            >
              {purge.isPending ? "Purging…" : "Purge"}
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
