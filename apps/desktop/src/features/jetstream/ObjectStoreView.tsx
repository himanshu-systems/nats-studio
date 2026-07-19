import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ipc } from "@bindings";
import type { ObjectInfoDto, ObjectProgress } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, Panel, SectionLabel, cx } from "../../components/ui";
import { Select } from "../../components/Select";
import { errorMessage } from "../messaging/message";

const bucketsKey = (connId: string): [string, string] => ["objBuckets", connId];
const objectsKey = (connId: string, bucket: string): [string, string, string] => [
  "objObjects",
  connId,
  bucket,
];

/** Human-readable byte size. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * Encode bytes to base64 in 0x8000-byte chunks — a single
 * `String.fromCharCode(...bytes)` blows the argument-count stack for large files.
 */
function chunkedBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Trailing path segment of a native file path (handles `\` and `/`). */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Streaming transfer progress bar (bytes / total). */
function ProgressBar({ p, label }: { p: ObjectProgress | null; label: string }): JSX.Element {
  const pct = p && p.total > 0 ? Math.min(100, (p.bytes / p.total) * 100) : p?.done ? 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>{label}</span>
        <span className="tabular-nums">
          {p ? `${formatBytes(p.bytes)} / ${formatBytes(p.total)}` : "starting…"}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** base64 -> Blob download via a synthetic anchor. */
function downloadBase64(name: string, b64: string): void {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ObjectStoreView(): JSX.Element {
  return (
    <RequireConnection>{(connId) => <ObjectStore connId={connId} />}</RequireConnection>
  );
}

function ObjectStore({ connId }: { connId: string }): JSX.Element {
  const qc = useQueryClient();
  const buckets = useQuery({
    queryKey: bucketsKey(connId),
    queryFn: () => ipc.jetstream.listObjectBuckets({ connectionId: connId }),
  });
  const bucketNames = (buckets.data?.buckets ?? []).map((b) => b.bucket);

  const [pickedBucket, setPickedBucket] = useState<string | null>(null);
  const bucket = pickedBucket ?? bucketNames[0] ?? null;

  const [selected, setSelected] = useState<string | null>(null);

  const objects = useQuery({
    queryKey: objectsKey(connId, bucket ?? ""),
    queryFn: () => ipc.jetstream.listObjects({ connectionId: connId, bucket: bucket ?? "" }),
    enabled: bucket !== null,
  });
  const objectList = objects.data?.objects ?? [];
  const selectedObject = objectList.find((o) => o.name === selected) ?? null;

  const fileRef = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const buf = new Uint8Array(await file.arrayBuffer());
      const b64 = chunkedBase64(buf);
      return ipc.jetstream.objectPut({
        connectionId: connId,
        bucket: bucket ?? "",
        name: file.name,
        dataBase64: b64,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: objectsKey(connId, bucket ?? "") }),
  });

  // Streaming upload: pick a real file path, stream it in Rust (no base64), show
  // a live progress bar. Sits alongside the small-file `upload` mutation above.
  const [streamUp, setStreamUp] = useState<{ name: string; p: ObjectProgress | null } | null>(
    null,
  );
  const [streamUpErr, setStreamUpErr] = useState<string | null>(null);

  async function streamUpload(): Promise<void> {
    if (!bucket) return;
    const picked = await open({ multiple: false, title: "Pick a file to upload" });
    if (typeof picked !== "string") return;
    const name = basename(picked);
    setStreamUpErr(null);
    setStreamUp({ name, p: null });
    try {
      await ipc.jetstream.objectPutFile(
        { connectionId: connId, bucket, name, path: picked },
        (p) => setStreamUp((s) => (s ? { ...s, p } : s)),
      );
      void qc.invalidateQueries({ queryKey: objectsKey(connId, bucket) });
    } catch (e) {
      setStreamUpErr(errorMessage(e));
    } finally {
      setStreamUp(null);
    }
  }

  return (
    <div className="mx-auto grid h-full max-w-6xl gap-4 overflow-hidden p-4 lg:grid-cols-[1fr_300px]">
      <div className="grid min-h-0 grid-rows-[auto_1fr] gap-3 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel>Object Store{bucket ? ` — ${bucket} (${objectList.length})` : ""}</SectionLabel>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.mutate(file);
              e.target.value = "";
            }}
          />
          <Button
            size="sm"
            icon="plus"
            onClick={() => fileRef.current?.click()}
            disabled={bucket === null || upload.isPending}
          >
            {upload.isPending ? "Uploading…" : "Upload"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            icon="send"
            onClick={() => void streamUpload()}
            disabled={bucket === null || streamUp !== null}
          >
            {streamUp ? "Streaming…" : "Stream file"}
          </Button>
            <Select
              className="w-44"
              value={bucket ?? ""}
              onChange={(v) => {
                setPickedBucket(v);
                setSelected(null);
              }}
              options={bucketNames.map((n) => ({ value: n, label: n }))}
              disabled={bucketNames.length === 0}
              placeholder="No buckets"
            />
            <Button
              size="sm"
              variant="outline"
              icon="replay"
              onClick={() => void objects.refetch()}
              disabled={bucket === null || objects.isFetching}
            >
              {objects.isFetching ? "…" : "Refresh"}
            </Button>
          </div>
        </div>

        {buckets.isError && <p className="text-xs text-danger">{errorMessage(buckets.error)}</p>}
        {upload.isError && <p className="text-xs text-danger">{errorMessage(upload.error)}</p>}
        {streamUp && <ProgressBar p={streamUp.p} label={`Uploading ${streamUp.name}`} />}
        {streamUpErr && <p className="text-xs text-danger">{streamUpErr}</p>}

        {bucket === null && !buckets.isLoading ? (
          <EmptyState icon="cube" title="No Object-Store buckets">
            Create one with the form on the right.
          </EmptyState>
        ) : (
          <div className="grid min-h-0 gap-3 sm:grid-cols-[220px_1fr]">
            <Panel className="flex min-h-0 flex-col overflow-hidden p-2">
            {objects.isError && (
              <p className="p-2 text-xs text-danger">{errorMessage(objects.error)}</p>
            )}
            {objectList.length === 0 && !objects.isLoading ? (
              <p className="p-3 text-xs text-muted">No objects in this bucket.</p>
            ) : (
              <ul className="min-h-0 space-y-0.5 overflow-auto">
                {objectList.map((o) => (
                  <li key={o.name}>
                    <button
                      type="button"
                      onClick={() => setSelected(o.name)}
                      className={cx(
                        "w-full rounded-lg px-2.5 py-1.5 text-left",
                        o.name === selected
                          ? "bg-accent/10 text-accent"
                          : "text-content hover:bg-surface-2",
                      )}
                    >
                      <span className="block truncate font-mono text-xs">{o.name}</span>
                      <span className="text-[11px] text-muted">{formatBytes(o.size)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <div className="min-h-0 space-y-4 overflow-auto">
            {bucket && selectedObject ? (
              <ObjectDetail
                connId={connId}
                bucket={bucket}
                object={selectedObject}
                onDeleted={() => setSelected(null)}
              />
            ) : (
              <EmptyState icon="cube" title="Select an object">
                Pick an object to see its info and download it, or upload a new one.
              </EmptyState>
            )}
          </div>
        </div>
      )}
      </div>

      <div className="space-y-4 overflow-auto">
        <CreateObjectBucketForm
          connId={connId}
          onCreated={(b) => {
            setPickedBucket(b);
            setSelected(null);
          }}
        />
      </div>
    </div>
  );
}

function CreateObjectBucketForm({
  connId,
  onCreated,
}: {
  connId: string;
  onCreated: (bucket: string) => void;
}): JSX.Element {
  const qc = useQueryClient();
  const [bucket, setBucket] = useState("");
  const [ttlSec, setTtlSec] = useState("");
  const [storage, setStorage] = useState("file");

  const create = useMutation({
    mutationFn: () => {
      const ttl = ttlSec.trim();
      return ipc.jetstream.objectCreateBucket({
        connectionId: connId,
        bucket: bucket.trim(),
        ttlSeconds: ttl === "" ? undefined : Math.max(0, Math.floor(Number(ttl))),
        storage,
      });
    },
    onSuccess: () => {
      const created = bucket.trim();
      setBucket("");
      setTtlSec("");
      void qc.invalidateQueries({ queryKey: bucketsKey(connId) });
      onCreated(created);
    },
  });

  const canSubmit = bucket.trim() !== "" && !create.isPending;

  return (
    <Panel className="h-fit space-y-3 p-4">
      <SectionLabel>Create bucket</SectionLabel>
      <label className="block space-y-1.5">
        <span className="text-[11px] text-muted">Bucket name</span>
        <input
          className="field font-mono"
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          placeholder="assets"
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-[11px] text-muted">TTL (s)</span>
        <input
          className="field tabular-nums"
          value={ttlSec}
          onChange={(e) => setTtlSec(e.target.value)}
          placeholder="∞"
          inputMode="numeric"
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-[11px] text-muted">Storage</span>
        <Select
          value={storage}
          onChange={setStorage}
          options={[
            { value: "file", label: "File" },
            { value: "memory", label: "Memory" },
          ]}
        />
      </label>
      <Button
        icon="plus"
        className="w-full"
        onClick={() => create.mutate()}
        disabled={!canSubmit}
      >
        {create.isPending ? "Creating…" : "Create bucket"}
      </Button>
      {create.isError && <p className="text-xs text-danger">{errorMessage(create.error)}</p>}
    </Panel>
  );
}

function ObjectDetail({
  connId,
  bucket,
  object,
  onDeleted,
}: {
  connId: string;
  bucket: string;
  object: ObjectInfoDto;
  onDeleted: () => void;
}): JSX.Element {
  const qc = useQueryClient();

  const download = useMutation({
    mutationFn: () =>
      ipc.jetstream.getObject({ connectionId: connId, bucket, name: object.name }),
    onSuccess: (res) => downloadBase64(res.name, res.dataBase64),
  });

  // Streaming download: pick a destination path, stream in Rust (uncapped), with
  // a live progress bar. Sits alongside the small-file base64 `download` above.
  const [dl, setDl] = useState<ObjectProgress | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamErr, setStreamErr] = useState<string | null>(null);

  async function streamDownload(): Promise<void> {
    const picked = await save({ defaultPath: object.name, title: "Save object as" });
    if (!picked) return;
    setStreamErr(null);
    setDl(null);
    setStreaming(true);
    try {
      await ipc.jetstream.objectGetFile(
        { connectionId: connId, bucket, name: object.name, path: picked },
        setDl,
      );
    } catch (e) {
      setStreamErr(errorMessage(e));
    } finally {
      setStreaming(false);
    }
  }

  const remove = useMutation({
    mutationFn: () =>
      ipc.jetstream.deleteObject({ connectionId: connId, bucket, name: object.name }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: objectsKey(connId, bucket) });
      onDeleted();
    },
  });

  return (
    <Panel className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm text-content">{object.name}</span>
          <Badge tone="neutral">{formatBytes(object.size)}</Badge>
          {object.deleted && <Badge tone="danger">deleted</Badge>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            icon="check"
            onClick={() => download.mutate()}
            disabled={download.isPending}
          >
            {download.isPending ? "Fetching…" : "Download"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            icon="inbox"
            onClick={() => void streamDownload()}
            disabled={streaming}
          >
            {streaming ? "Streaming…" : "Stream to file"}
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon="trash"
            onClick={() => {
              if (window.confirm(`Delete object "${object.name}"? This cannot be undone.`)) {
                remove.mutate();
              }
            }}
          >
            Delete
          </Button>
        </div>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-muted">Size</dt>
        <dd className="font-mono text-content">
          {object.size.toLocaleString()} bytes ({formatBytes(object.size)})
        </dd>
        <dt className="text-muted">Modified</dt>
        <dd className="font-mono text-content">{object.modifiedRfc3339 || "—"}</dd>
        <dt className="text-muted">Digest</dt>
        <dd className="break-all font-mono text-content">{object.digest ?? "—"}</dd>
      </dl>

      {(streaming || dl) && <ProgressBar p={dl} label={`Downloading ${object.name}`} />}
      {streamErr && <p className="text-xs text-danger">{streamErr}</p>}
      {download.isError && <p className="text-xs text-danger">{errorMessage(download.error)}</p>}
      {remove.isError && <p className="text-xs text-danger">{errorMessage(remove.error)}</p>}
    </Panel>
  );
}
