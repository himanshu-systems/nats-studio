import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@bindings";
import type { ObjectInfoDto } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, Panel, SectionLabel, cx } from "../../components/ui";
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

  return (
    <div className="mx-auto grid h-full max-w-6xl grid-rows-[auto_1fr] gap-4 overflow-hidden p-4">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>
          Object Store{bucket ? ` — ${bucket} (${objectList.length})` : ""}
        </SectionLabel>
        <div className="flex items-center gap-2">
          <select
            className="field h-8 max-w-[220px] text-xs"
            value={bucket ?? ""}
            onChange={(e) => {
              setPickedBucket(e.target.value);
              setSelected(null);
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
            onClick={() => void objects.refetch()}
            disabled={bucket === null || objects.isFetching}
          >
            {objects.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {buckets.isError && <p className="text-xs text-danger">{errorMessage(buckets.error)}</p>}

      {bucket === null && !buckets.isLoading ? (
        <EmptyState icon="cube" title="No Object-Store buckets">
          This account has no JetStream Object-Store buckets yet.
        </EmptyState>
      ) : (
        <div className="grid min-h-0 gap-4 lg:grid-cols-[280px_1fr]">
          <Panel className="flex min-h-0 flex-col p-2">
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
                Pick an object to see its info and download it.
              </EmptyState>
            )}
          </div>
        </div>
      )}
    </div>
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

      {download.isError && <p className="text-xs text-danger">{errorMessage(download.error)}</p>}
      {remove.isError && <p className="text-xs text-danger">{errorMessage(remove.error)}</p>}
      <p className="text-[11px] text-muted">
        Uploads are not supported in v1 (streaming large uploads over IPC is heavy).
      </p>
    </Panel>
  );
}
