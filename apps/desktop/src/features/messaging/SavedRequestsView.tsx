import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ipc,
  PayloadEncoding,
  SavedRequestMode,
  type MessageHeader,
  type MessageView,
  type SavedRequestDto,
  type SavedRequestInput,
} from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Badge, Button, EmptyState, Panel, SectionLabel } from "../../components/ui";
import { Select } from "../../components/Select";
import { ErrorNote } from "../../components/ErrorNote";
import { useConfirm } from "../../components/ConfirmDialog";
import { errorMessage, MessageMeta, parseHeaders, PayloadView } from "./message";

const SAVED_REQUESTS_KEY = ["savedRequests"] as const;

/** Render headers back into the `Key: Value` per-line shape the form edits. */
function headersToRaw(headers: MessageHeader[]): string {
  return headers.map((h) => `${h.name}: ${h.value}`).join("\n");
}

export function SavedRequestsView(): JSX.Element {
  return <RequireConnection>{(connId) => <SavedRequests connId={connId} />}</RequireConnection>;
}

function SavedRequests({ connId }: { connId: string }): JSX.Element {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const list = useQuery({ queryKey: SAVED_REQUESTS_KEY, queryFn: () => ipc.savedRequests.list() });
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, MessageView>>({});
  const [fireErrors, setFireErrors] = useState<Record<string, unknown>>({});
  const [firingId, setFiringId] = useState<string | null>(null);

  const invalidate = (): void => void qc.invalidateQueries({ queryKey: SAVED_REQUESTS_KEY });

  const create = useMutation({
    mutationFn: (input: SavedRequestInput) => ipc.savedRequests.create(input),
    onSuccess: () => {
      invalidate();
      setCreating(false);
    },
  });
  const update = useMutation({
    mutationFn: (request: SavedRequestDto) => ipc.savedRequests.update(request),
    onSuccess: () => {
      invalidate();
      setEditingId(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => ipc.savedRequests.delete(id),
    onSuccess: invalidate,
  });

  const fire = async (r: SavedRequestDto): Promise<void> => {
    setFiringId(r.id);
    setFireErrors((e) => {
      if (!(r.id in e)) return e;
      const next = { ...e };
      delete next[r.id];
      return next;
    });
    try {
      if (r.mode === SavedRequestMode.Request) {
        const view = await ipc.pubsub.request({
          connectionId: connId,
          subject: r.subject,
          payload: r.payload,
          encoding: r.encoding,
          headers: r.headers,
          timeoutMs: r.timeoutMs,
        });
        setReplies((prev) => ({ ...prev, [r.id]: view }));
      } else {
        await ipc.pubsub.publish({
          connectionId: connId,
          subject: r.subject,
          payload: r.payload,
          encoding: r.encoding,
          headers: r.headers,
        });
      }
    } catch (e) {
      setFireErrors((prev) => ({ ...prev, [r.id]: e }));
    } finally {
      setFiringId(null);
    }
  };

  const requests = list.data?.requests ?? [];

  return (
    <div className="h-full space-y-3 overflow-auto p-4">
      <div className="flex items-center justify-between">
        <SectionLabel>Saved requests{requests.length > 0 ? ` (${requests.length})` : ""}</SectionLabel>
        {!creating && (
          <Button size="sm" icon="plus" onClick={() => setCreating(true)}>
            New template
          </Button>
        )}
      </div>

      {list.isError && <ErrorNote error={list.error} />}

      {creating && (
        <Panel className="p-4">
          <SavedRequestForm
            pending={create.isPending}
            error={create.isError ? errorMessage(create.error) : null}
            submitLabel="Save template"
            onCancel={() => setCreating(false)}
            onSubmit={(input) => create.mutate(input)}
          />
        </Panel>
      )}

      {requests.length === 0 && !creating ? (
        <EmptyState icon="archive" title="No saved requests yet">
          Save a publish or request pattern you test over and over, then fire it with one click instead
          of retyping it every time.
        </EmptyState>
      ) : (
        <ul className="space-y-2.5">
          {requests.map((r) =>
            editingId === r.id ? (
              <Panel key={r.id} className="p-4">
                <SavedRequestForm
                  initial={r}
                  pending={update.isPending}
                  error={update.isError ? errorMessage(update.error) : null}
                  submitLabel="Save changes"
                  onCancel={() => setEditingId(null)}
                  onSubmit={(input) => update.mutate({ ...r, ...input })}
                />
              </Panel>
            ) : (
              <SavedRequestCard
                key={r.id}
                request={r}
                firing={firingId === r.id}
                reply={replies[r.id] ?? null}
                fireError={fireErrors[r.id]}
                onFire={() => void fire(r)}
                onEdit={() => setEditingId(r.id)}
                onDelete={() => {
                  void confirm({
                    title: `Delete saved request "${r.name}"?`,
                    description: "This cannot be undone.",
                    consequences: [`Its subject (${r.subject}) and payload template will be removed.`],
                    confirmLabel: "Delete template",
                    confirmIcon: "trash",
                  }).then((ok) => {
                    if (ok) remove.mutate(r.id);
                  });
                }}
              />
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function SavedRequestCard({
  request,
  firing,
  reply,
  fireError,
  onFire,
  onEdit,
  onDelete,
}: {
  request: SavedRequestDto;
  firing: boolean;
  reply: MessageView | null;
  fireError: unknown;
  onFire: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  const isRequest = request.mode === SavedRequestMode.Request;
  return (
    <li>
      <Panel className="space-y-2.5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-content">{request.name}</span>
              <Badge tone={isRequest ? "accent" : "neutral"}>{isRequest ? "request" : "publish"}</Badge>
            </div>
            <div className="truncate font-mono text-xs text-muted">{request.subject}</div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" icon={isRequest ? "swap" : "send"} onClick={onFire} disabled={firing}>
              {firing ? "Firing…" : "Fire"}
            </Button>
            <Button size="sm" variant="ghost" icon="pencil" onClick={onEdit} aria-label="Edit template" />
            <Button size="sm" variant="ghost" icon="trash" onClick={onDelete} aria-label="Delete template" />
          </div>
        </div>
        {fireError !== undefined && <ErrorNote error={fireError} />}
        {reply && (
          <div className="space-y-2 border-t border-border/60 pt-2.5">
            <MessageMeta view={reply} />
            <PayloadView view={reply} />
          </div>
        )}
      </Panel>
    </li>
  );
}

/** Create/edit form for a saved template — the same payload/encoding/header
 *  concepts as the Publisher and Request-Reply compose forms. */
function SavedRequestForm(props: {
  initial?: SavedRequestDto;
  pending: boolean;
  error: string | null;
  submitLabel: string;
  onCancel?: () => void;
  onSubmit: (input: SavedRequestInput) => void;
}): JSX.Element {
  const init = props.initial;
  const [name, setName] = useState(init?.name ?? "");
  const [subject, setSubject] = useState(init?.subject ?? "");
  const [mode, setMode] = useState<SavedRequestMode>(init?.mode ?? SavedRequestMode.Publish);
  const [payload, setPayload] = useState(init?.payload ?? "");
  const [encoding, setEncoding] = useState<PayloadEncoding>(init?.encoding ?? PayloadEncoding.Utf8);
  const [headersRaw, setHeadersRaw] = useState(init ? headersToRaw(init.headers) : "");
  const [timeoutMs, setTimeoutMs] = useState(init?.timeoutMs ?? 2000);

  const submit = (): void => {
    props.onSubmit({
      name: name.trim(),
      subject: subject.trim(),
      mode,
      payload,
      encoding,
      headers: parseHeaders(headersRaw),
      timeoutMs,
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-2.5"
    >
      <div className="grid grid-cols-2 gap-2">
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" />
        <Select
          value={mode}
          onChange={(v) => setMode(v as SavedRequestMode)}
          options={[
            { value: SavedRequestMode.Publish, label: "Publish" },
            { value: SavedRequestMode.Request, label: "Request" },
          ]}
        />
      </div>
      <input className="field font-mono" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="orders.new" />
      <textarea
        className="field-mono min-h-[120px]"
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        spellCheck={false}
        placeholder="Payload"
      />
      <div className="grid grid-cols-2 gap-2">
        <Select
          value={encoding}
          onChange={(v) => setEncoding(v as PayloadEncoding)}
          options={[
            { value: PayloadEncoding.Utf8, label: "UTF-8" },
            { value: PayloadEncoding.Base64, label: "Base64" },
          ]}
        />
        {mode === SavedRequestMode.Request && (
          <input
            type="number"
            min={100}
            step={100}
            className="field tabular-nums"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value) || 0)}
            placeholder="Timeout (ms)"
          />
        )}
      </div>
      <textarea
        className="field-mono min-h-[56px]"
        value={headersRaw}
        onChange={(e) => setHeadersRaw(e.target.value)}
        placeholder="X-Trace-Id: abc123"
        spellCheck={false}
      />
      {props.error && <p className="text-xs text-danger">{props.error}</p>}
      <div className="flex gap-2">
        <Button
          type="submit"
          className="flex-1"
          icon={init ? "check" : "plus"}
          disabled={props.pending || name.trim() === "" || subject.trim() === ""}
        >
          {props.pending ? "Saving…" : props.submitLabel}
        </Button>
        {props.onCancel && (
          <Button type="button" variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
