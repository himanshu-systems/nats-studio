import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@bindings";
import type { StoredMessageDto } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, Panel, SectionLabel, cx } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { Select } from "../../components/Select";
import { errorMessage } from "../messaging/message";

const PAGE = 50;

const streamsKey = (connId: string): [string, string] => ["streams", connId];
const messagesKey = (
  connId: string,
  stream: string,
  startSeq: number,
): [string, string, string, number] => ["jsMessages", connId, stream, startSeq];

/** Decode base64 to UTF-8, or `null` if the bytes aren't valid UTF-8 (binary). */
function base64ToUtf8(b64: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function MessageBrowserView(): JSX.Element {
  return <RequireConnection>{(connId) => <Browser connId={connId} />}</RequireConnection>;
}

function Browser({ connId }: { connId: string }): JSX.Element {
  const streams = useQuery({
    queryKey: streamsKey(connId),
    queryFn: () => ipc.jetstream.listStreams({ connectionId: connId }),
  });
  const streamNames = (streams.data?.streams ?? []).map((s) => s.config.name);

  const [pickedStream, setPickedStream] = useState<string | null>(null);
  const stream = pickedStream ?? streamNames[0] ?? null;

  const [startSeq, setStartSeq] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);

  const page = useQuery({
    queryKey: messagesKey(connId, stream ?? "", startSeq),
    queryFn: () =>
      ipc.jetstream.getMessages({
        connectionId: connId,
        stream: stream ?? "",
        startSeq,
        limit: PAGE,
      }),
    enabled: stream !== null,
  });

  const messages = page.data?.messages ?? [];
  const firstSeq = page.data?.firstSeq ?? 0;
  const lastSeq = page.data?.lastSeq ?? 0;
  const lastOnPage = messages.at(-1)?.seq ?? startSeq;

  const canPrev = stream !== null && startSeq > firstSeq && !page.isFetching;
  const canNext =
    stream !== null && messages.length > 0 && lastOnPage < lastSeq && !page.isFetching;

  const resetTo = (seq: number): void => {
    setStartSeq(seq);
    setSelected(null);
  };

  const selectedMsg = messages.find((m) => m.seq === selected) ?? null;

  return (
    <div className="mx-auto grid h-full max-w-6xl grid-rows-[auto_1fr] gap-4 overflow-hidden p-4">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>
          Messages{stream ? ` — ${stream}` : ""}
          {stream && lastSeq > 0 ? ` (seq ${firstSeq}–${lastSeq})` : ""}
        </SectionLabel>
        <div className="flex items-center gap-2">
          <Select
            className="max-w-[220px]"
            value={stream ?? ""}
            onChange={(v) => {
              setPickedStream(v);
              resetTo(1);
            }}
            options={streamNames.map((n) => ({ value: n, label: n }))}
            disabled={streamNames.length === 0}
            placeholder="No streams"
          />
          <Button
            size="sm"
            variant="outline"
            icon="replay"
            onClick={() => void page.refetch()}
            disabled={stream === null || page.isFetching}
          >
            {page.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {streams.isError && <p className="text-xs text-danger">{errorMessage(streams.error)}</p>}

      {stream === null && !streams.isLoading ? (
        <EmptyState icon="database" title="No streams">
          This account has no JetStream streams to browse.
        </EmptyState>
      ) : (
        <div className="grid min-h-0 gap-4 lg:grid-cols-[1fr_360px]">
          <Panel className="flex min-h-0 flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-border/60 p-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => resetTo(Math.max(firstSeq, startSeq - PAGE))}
                disabled={!canPrev}
              >
                Prev
              </Button>
              <span className="text-[11px] tabular-nums text-muted">
                {messages.length > 0
                  ? `seq ${messages[0]?.seq}–${lastOnPage}`
                  : page.isLoading
                    ? "Loading…"
                    : "No messages in range"}
              </span>
              <Button
                size="sm"
                variant="outline"
                icon="chevron-right"
                onClick={() => resetTo(lastOnPage + 1)}
                disabled={!canNext}
              >
                Next
              </Button>
            </div>

            {page.isError && <p className="p-2 text-xs text-danger">{errorMessage(page.error)}</p>}

            {messages.length === 0 && !page.isLoading ? (
              <p className="p-3 text-xs text-muted">No messages in this stream range.</p>
            ) : (
              <ul className="min-h-0 divide-y divide-border/50 overflow-auto">
                {messages.map((m) => (
                  <li key={m.seq}>
                    <button
                      type="button"
                      onClick={() => setSelected(m.seq)}
                      className={cx(
                        "flex w-full items-center gap-3 px-3 py-2 text-left text-xs",
                        m.seq === selected ? "bg-accent/10" : "hover:bg-surface-2",
                      )}
                    >
                      <span className="w-16 shrink-0 tabular-nums text-muted">#{m.seq}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-content">
                        {m.subject}
                      </span>
                      <span className="shrink-0 tabular-nums text-faint">{m.size} B</span>
                      <span className="hidden shrink-0 text-faint sm:inline">
                        {new Date(m.timeRfc3339).toLocaleTimeString()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <div className="min-h-0 overflow-auto">
            {selectedMsg ? (
              <MessageDetail
                connId={connId}
                stream={stream!}
                msg={selectedMsg}
                onDeleted={() => setSelected(null)}
              />
            ) : (
              <Panel className="p-4">
                <p className="text-xs text-muted">Select a message to view its payload.</p>
              </Panel>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MessageDetail({
  connId,
  stream,
  msg,
  onDeleted,
}: {
  connId: string;
  stream: string;
  msg: StoredMessageDto;
  onDeleted: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);

  const text = base64ToUtf8(msg.payloadBase64);
  const binary = text === null;
  const preview = text ?? msg.payloadBase64;

  const remove = useMutation({
    mutationFn: () =>
      ipc.jetstream.deleteMessage({ connectionId: connId, stream, seq: msg.seq }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["jsMessages", connId, stream] });
      onDeleted();
    },
  });

  const copy = (): void => {
    void navigator.clipboard.writeText(preview).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <Panel className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone="neutral">#{msg.seq}</Badge>
          <span className="truncate font-mono text-sm text-content">{msg.subject}</span>
          {binary && <Badge tone="warning">binary</Badge>}
        </div>
        <Button
          size="sm"
          variant="danger"
          icon="trash"
          className="shrink-0"
          onClick={() => {
            if (window.confirm(`Delete message #${msg.seq}? This cannot be undone.`)) {
              remove.mutate();
            }
          }}
        >
          Delete
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
        <span className="tabular-nums">{msg.size} B</span>
        <span>{new Date(msg.timeRfc3339).toLocaleString()}</span>
      </div>

      {msg.headers.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg border border-border bg-surface-2 p-2 text-xs">
          {msg.headers.map((h, i) => (
            <div key={i} className="contents">
              <dt className="font-mono text-muted">{h.name}</dt>
              <dd className="truncate font-mono text-content">{h.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="relative">
        <button
          type="button"
          onClick={copy}
          className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-1 text-[11px] text-muted transition-colors hover:text-content"
        >
          <Icon name={copied ? "check" : "copy"} size={13} />
          {copied ? "Copied" : "Copy"}
        </button>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2 p-3 pr-16 font-mono text-xs leading-relaxed text-content">
          {preview || <span className="text-faint">(empty payload)</span>}
        </pre>
      </div>
      {binary && (
        <p className="text-[11px] text-muted">Payload isn't valid UTF-8 — showing base64.</p>
      )}
      {remove.isError && <p className="text-xs text-danger">{errorMessage(remove.error)}</p>}
    </Panel>
  );
}
