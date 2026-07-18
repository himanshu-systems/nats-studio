import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc, PayloadEncoding } from "@bindings";
import type { MessageHeader } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, Panel, SectionLabel, cx } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { Select } from "../../components/Select";
import { errorMessage } from "../messaging/message";

const PAGE = 100;

/** One message in a logical backup — enough to re-publish it. */
interface BackupMessage {
  subject: string;
  headers: MessageHeader[];
  payloadBase64: string;
}
interface BackupFile {
  stream: string;
  exportedAt: string;
  count: number;
  messages: BackupMessage[];
}

const streamsKey = (connId: string): [string, string] => ["streams", connId];

/** Trigger a browser download of a text blob (no libs, revokes the object URL). */
function downloadJson(filename: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function BackupView(): JSX.Element {
  return <RequireConnection>{(connId) => <Backup connId={connId} />}</RequireConnection>;
}

function Backup({ connId }: { connId: string }): JSX.Element {
  const streams = useQuery({
    queryKey: streamsKey(connId),
    queryFn: () => ipc.jetstream.listStreams({ connectionId: connId }),
  });
  const streamNames = (streams.data?.streams ?? []).map((s) => s.config.name);

  const stopRef = useRef(false);

  // Export state.
  const [pickedStream, setPickedStream] = useState<string | null>(null);
  const stream = pickedStream ?? streamNames[0] ?? null;
  const [exporting, setExporting] = useState(false);
  const [exportCount, setExportCount] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportDone, setExportDone] = useState<string | null>(null);

  // Restore state.
  const [prefix, setPrefix] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<{
    done: number;
    failed: number;
    total: number;
  } | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreDone, setRestoreDone] = useState<string | null>(null);

  async function runExport(): Promise<void> {
    if (!stream) return;
    stopRef.current = false;
    setExporting(true);
    setExportError(null);
    setExportDone(null);
    setExportCount(0);
    const messages: BackupMessage[] = [];
    try {
      let start = 1;
      // ponytail: whole stream in memory as one JSON blob. Fine for dev-scale
      // streams; ceiling ~ browser memory. Upgrade path: chunked/streamed export.
      for (;;) {
        if (stopRef.current) break;
        const page = await ipc.jetstream.getMessages({
          connectionId: connId,
          stream,
          startSeq: start,
          limit: PAGE,
        });
        const msgs = page.messages;
        if (msgs.length === 0) break;
        for (const m of msgs) {
          messages.push({ subject: m.subject, headers: m.headers, payloadBase64: m.payloadBase64 });
        }
        setExportCount(messages.length);
        const lastOnPage = msgs[msgs.length - 1]!.seq;
        if (lastOnPage >= page.lastSeq) break;
        start = lastOnPage + 1;
      }
      const backup: BackupFile = {
        stream,
        exportedAt: new Date().toISOString(),
        count: messages.length,
        messages,
      };
      downloadJson(`nats-backup-${stream}.json`, JSON.stringify(backup, null, 2));
      setExportDone(
        stopRef.current
          ? `Stopped — downloaded ${messages.length} message(s).`
          : `Exported ${messages.length} message(s).`,
      );
    } catch (e) {
      setExportError(errorMessage(e));
    } finally {
      setExporting(false);
    }
  }

  async function runRestore(): Promise<void> {
    if (!file) return;
    stopRef.current = false;
    setRestoring(true);
    setRestoreError(null);
    setRestoreDone(null);
    setRestoreProgress(null);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const list = (parsed as BackupFile | null)?.messages;
      if (!Array.isArray(list)) {
        throw new Error("Invalid backup file: missing a `messages` array.");
      }
      const override = prefix.trim();
      let done = 0;
      let failed = 0;
      setRestoreProgress({ done: 0, failed: 0, total: list.length });
      for (const m of list) {
        if (stopRef.current) break;
        if (typeof m?.payloadBase64 !== "string") {
          failed += 1;
          setRestoreProgress({ done, failed, total: list.length });
          continue;
        }
        try {
          await ipc.pubsub.publish({
            connectionId: connId,
            subject: override || m.subject,
            payload: m.payloadBase64,
            encoding: PayloadEncoding.Base64,
            headers: m.headers ?? [],
          });
          done += 1;
        } catch {
          failed += 1;
        }
        setRestoreProgress({ done, failed, total: list.length });
      }
      setRestoreDone(
        `${stopRef.current ? "Stopped. " : "Done. "}Published ${done}, failed ${failed}, of ${list.length}.`,
      );
    } catch (e) {
      setRestoreError(errorMessage(e));
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 overflow-auto p-4">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>Backup &amp; Restore</SectionLabel>
        <Badge tone="neutral">logical</Badge>
      </div>
      <p className="text-xs text-muted">
        Logical backup — re-publishes messages; not a JetStream server snapshot.
      </p>

      {streams.isError && <p className="text-xs text-danger">{errorMessage(streams.error)}</p>}

      {/* Export */}
      <Panel className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Icon name="archive" size={16} />
          <span className="text-sm font-semibold text-content">Export</span>
        </div>
        <p className="text-xs text-muted">
          Page through a stream and download every message as a JSON file.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="max-w-[220px]"
            value={stream ?? ""}
            onChange={(v) => setPickedStream(v)}
            options={streamNames.map((n) => ({ value: n, label: n }))}
            disabled={streamNames.length === 0 || exporting}
            placeholder="No streams"
          />
          <Button
            size="sm"
            icon="archive"
            onClick={() => void runExport()}
            disabled={stream === null || exporting}
          >
            {exporting ? "Exporting…" : "Export"}
          </Button>
          {exporting && (
            <Button size="sm" variant="outline" onClick={() => (stopRef.current = true)}>
              Stop
            </Button>
          )}
        </div>
        {exporting && (
          <p className="text-xs tabular-nums text-muted">{exportCount} message(s) exported…</p>
        )}
        {exportDone && (
          <p className="inline-flex items-center gap-1.5 text-xs text-positive">
            <Icon name="check" size={14} />
            {exportDone}
          </p>
        )}
        {exportError && <p className="text-xs text-danger">{exportError}</p>}
      </Panel>

      {/* Restore */}
      <Panel className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Icon name="send" size={16} />
          <span className="text-sm font-semibold text-content">Restore</span>
        </div>
        <p className="text-xs text-muted">
          Upload a backup file and re-publish its messages. Failures are counted and skipped.
        </p>
        <label className="block space-y-1">
          <span className="text-[11px] text-muted">Subject override (optional)</span>
          <input
            className="field h-8 w-full text-xs"
            placeholder="Leave blank to keep each message's original subject"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            disabled={restoring}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setRestoreDone(null);
              setRestoreError(null);
              setRestoreProgress(null);
            }}
            disabled={restoring}
            className="text-xs text-muted file:mr-2 file:rounded-lg file:border file:border-border file:bg-surface file:px-2.5 file:py-1 file:text-xs file:text-content hover:file:bg-surface-2"
          />
          <Button
            size="sm"
            icon="send"
            onClick={() => void runRestore()}
            disabled={file === null || restoring}
          >
            {restoring ? "Restoring…" : "Restore"}
          </Button>
          {restoring && (
            <Button size="sm" variant="outline" onClick={() => (stopRef.current = true)}>
              Stop
            </Button>
          )}
        </div>
        {restoreProgress && (
          <p className={cx("text-xs tabular-nums", restoring ? "text-muted" : "text-content")}>
            {restoreProgress.done + restoreProgress.failed} / {restoreProgress.total} · published{" "}
            {restoreProgress.done}
            {restoreProgress.failed > 0 && ` · failed ${restoreProgress.failed}`}
          </p>
        )}
        {restoreDone && (
          <p className="inline-flex items-center gap-1.5 text-xs text-positive">
            <Icon name="check" size={14} />
            {restoreDone}
          </p>
        )}
        {restoreError && <p className="text-xs text-danger">{restoreError}</p>}
      </Panel>

      {streamNames.length === 0 && !streams.isLoading && (
        <EmptyState icon="archive" title="No streams">
          This account has no JetStream streams to back up.
        </EmptyState>
      )}
    </div>
  );
}
