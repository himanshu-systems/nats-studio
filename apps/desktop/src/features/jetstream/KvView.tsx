import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@bindings";
import type { KvEntryDto } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, Panel, SectionLabel, cx } from "../../components/ui";
import { errorMessage } from "../messaging/message";

const bucketsKey = (connId: string): [string, string] => ["kvBuckets", connId];
const keysKey = (connId: string, bucket: string): [string, string, string] => [
  "kvKeys",
  connId,
  bucket,
];
const entryKey = (
  connId: string,
  bucket: string,
  key: string,
): [string, string, string, string] => ["kvEntry", connId, bucket, key];

/** Encode a UTF-8 string to base64 (browser-safe for typical KV value sizes). */
function utf8ToBase64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

/** Decode base64 to UTF-8, or `null` if the bytes aren't valid UTF-8 (binary). */
function base64ToUtf8(b64: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function KvView(): JSX.Element {
  return <RequireConnection>{(connId) => <Kv connId={connId} />}</RequireConnection>;
}

function Kv({ connId }: { connId: string }): JSX.Element {
  const buckets = useQuery({
    queryKey: bucketsKey(connId),
    queryFn: () => ipc.jetstream.listBuckets({ connectionId: connId }),
  });
  const bucketNames = (buckets.data?.buckets ?? []).map((b) => b.bucket);

  const [pickedBucket, setPickedBucket] = useState<string | null>(null);
  const bucket = pickedBucket ?? bucketNames[0] ?? null;

  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const keys = useQuery({
    queryKey: keysKey(connId, bucket ?? ""),
    queryFn: () => ipc.jetstream.listKeys({ connectionId: connId, bucket: bucket ?? "" }),
    enabled: bucket !== null,
  });
  const keyList = keys.data?.keys ?? [];

  return (
    <div className="mx-auto grid h-full max-w-6xl grid-rows-[auto_1fr] gap-4 overflow-hidden p-4">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>Key-Value{bucket ? ` — ${bucket} (${keyList.length})` : ""}</SectionLabel>
        <div className="flex items-center gap-2">
          <select
            className="field h-8 max-w-[220px] text-xs"
            value={bucket ?? ""}
            onChange={(e) => {
              setPickedBucket(e.target.value);
              setSelectedKey(null);
            }}
            disabled={bucketNames.length === 0}
          >
            {bucketNames.length === 0 && <option value="">No buckets</option>}
            {bucketNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            icon="replay"
            onClick={() => void keys.refetch()}
            disabled={bucket === null || keys.isFetching}
          >
            {keys.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {buckets.isError && <p className="text-xs text-danger">{errorMessage(buckets.error)}</p>}

      {bucket === null && !buckets.isLoading ? (
        <EmptyState icon="key" title="No KV buckets">
          This account has no JetStream Key-Value buckets yet.
        </EmptyState>
      ) : (
        <div className="grid min-h-0 gap-4 lg:grid-cols-[240px_1fr]">
          <Panel className="flex min-h-0 flex-col p-2">
            {keys.isError && (
              <p className="p-2 text-xs text-danger">{errorMessage(keys.error)}</p>
            )}
            {keyList.length === 0 && !keys.isLoading ? (
              <p className="p-3 text-xs text-muted">No keys in this bucket.</p>
            ) : (
              <ul className="min-h-0 space-y-0.5 overflow-auto">
                {keyList.map((k) => (
                  <li key={k}>
                    <button
                      type="button"
                      onClick={() => setSelectedKey(k)}
                      className={cx(
                        "w-full truncate rounded-lg px-2.5 py-1.5 text-left font-mono text-xs",
                        k === selectedKey
                          ? "bg-accent/10 text-accent"
                          : "text-content hover:bg-surface-2",
                      )}
                    >
                      {k}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <div className="min-h-0 space-y-4 overflow-auto">
            {bucket && selectedKey && (
              <KeyDetail
                connId={connId}
                bucket={bucket}
                keyName={selectedKey}
                onDeleted={() => setSelectedKey(null)}
              />
            )}
            {bucket && (
              <NewKeyForm connId={connId} bucket={bucket} onCreated={setSelectedKey} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function KeyDetail({
  connId,
  bucket,
  keyName,
  onDeleted,
}: {
  connId: string;
  bucket: string;
  keyName: string;
  onDeleted: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const entry = useQuery({
    queryKey: entryKey(connId, bucket, keyName),
    queryFn: () => ipc.jetstream.kvGet({ connectionId: connId, bucket, key: keyName }),
  });

  const dto: KvEntryDto | null = entry.data?.entry ?? null;

  const [draft, setDraft] = useState("");
  // True when the stored value isn't UTF-8: we then edit/save base64 verbatim.
  const [binary, setBinary] = useState(false);

  // Reseed the editor whenever a fresh entry arrives (new key / revision).
  useEffect(() => {
    if (!dto) {
      setDraft("");
      setBinary(false);
      return;
    }
    const text = base64ToUtf8(dto.valueBase64);
    setBinary(text === null);
    setDraft(text ?? dto.valueBase64);
  }, [dto]);

  const save = useMutation({
    mutationFn: () =>
      ipc.jetstream.kvPut({
        connectionId: connId,
        bucket,
        key: keyName,
        valueBase64: binary ? draft.trim() : utf8ToBase64(draft),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: entryKey(connId, bucket, keyName) }),
  });

  const remove = useMutation({
    mutationFn: () => ipc.jetstream.kvDelete({ connectionId: connId, bucket, key: keyName }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keysKey(connId, bucket) });
      onDeleted();
    },
  });

  return (
    <Panel className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm text-content">{keyName}</span>
          {dto && <Badge tone="neutral">rev {dto.revision}</Badge>}
          {dto?.isDeleted && <Badge tone="danger">deleted</Badge>}
          {binary && <Badge tone="warning">binary (base64)</Badge>}
        </div>
        <Button
          size="sm"
          variant="danger"
          icon="trash"
          className="shrink-0"
          onClick={() => {
            if (window.confirm(`Delete key "${keyName}"? This writes a delete marker.`)) {
              remove.mutate();
            }
          }}
        >
          Delete
        </Button>
      </div>

      {entry.isError && <p className="text-xs text-danger">{errorMessage(entry.error)}</p>}

      <textarea
        className="field-mono min-h-[160px]"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        placeholder="(empty)"
      />
      <p className="text-[11px] text-muted">
        {binary
          ? "Value isn't valid UTF-8 — editing base64 verbatim."
          : "Plain-text (UTF-8) value. Stored as base64 on the wire."}
      </p>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          icon="check"
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          icon="replay"
          onClick={() => void entry.refetch()}
          disabled={entry.isFetching}
        >
          Reload
        </Button>
      </div>
      {save.isError && <p className="text-xs text-danger">{errorMessage(save.error)}</p>}
      {remove.isError && <p className="text-xs text-danger">{errorMessage(remove.error)}</p>}
    </Panel>
  );
}

function NewKeyForm({
  connId,
  bucket,
  onCreated,
}: {
  connId: string;
  bucket: string;
  onCreated: (key: string) => void;
}): JSX.Element {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const create = useMutation({
    mutationFn: () =>
      ipc.jetstream.kvPut({
        connectionId: connId,
        bucket,
        key: key.trim(),
        valueBase64: utf8ToBase64(value),
      }),
    onSuccess: () => {
      const created = key.trim();
      setKey("");
      setValue("");
      void qc.invalidateQueries({ queryKey: keysKey(connId, bucket) });
      onCreated(created);
    },
  });

  const canSubmit = key.trim() !== "" && !create.isPending;

  return (
    <Panel className="h-fit space-y-3 p-4">
      <SectionLabel>New key</SectionLabel>
      <label className="block space-y-1.5">
        <span className="text-[11px] text-muted">Key</span>
        <input
          className="field font-mono"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="config.timeout"
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-[11px] text-muted">Value (UTF-8)</span>
        <textarea
          className="field-mono min-h-[80px]"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
        />
      </label>
      <Button
        icon="plus"
        className="w-full"
        onClick={() => create.mutate()}
        disabled={!canSubmit}
      >
        {create.isPending ? "Saving…" : "Put key"}
      </Button>
      {create.isError && <p className="text-xs text-danger">{errorMessage(create.error)}</p>}
    </Panel>
  );
}
