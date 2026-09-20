import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, PayloadEncoding, SavedRequestMode, type MessageView, type SavedRequestDto } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { SplitPane } from "../../components/SplitPane";
import { Button, Panel, SectionLabel } from "../../components/ui";
import { Select } from "../../components/Select";
import { useConfirm } from "../../components/ConfirmDialog";
import { errorMessage, headersToRaw, MessageMeta, parseHeaders, PayloadView } from "./message";

const SAVED_REQUESTS_KEY = ["savedRequests"] as const;

export function RequestReplyView(): JSX.Element {
  return <RequireConnection>{(connId) => <RequestReply connId={connId} />}</RequireConnection>;
}

function RequestReply({ connId }: { connId: string }): JSX.Element {
  const [subject, setSubject] = useState("svc.echo");
  const [payload, setPayload] = useState('{ "ping": true }');
  const [encoding, setEncoding] = useState<PayloadEncoding>(PayloadEncoding.Utf8);
  const [headersRaw, setHeadersRaw] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(2000);
  const [reply, setReply] = useState<MessageView | null>(null);

  const request = useMutation({
    mutationFn: () =>
      ipc.pubsub.request({
        connectionId: connId,
        subject: subject.trim(),
        payload,
        encoding,
        headers: parseHeaders(headersRaw),
        timeoutMs,
      }),
    onSuccess: (view) => setReply(view),
  });

  // Saved templates — reuses the same store as the Saved Requests panel,
  // filtered to request-mode entries. Loading one fills the form below;
  // "Update" saves the (possibly edited) form back to it.
  const qc = useQueryClient();
  const confirm = useConfirm();
  const templatesQuery = useQuery({ queryKey: SAVED_REQUESTS_KEY, queryFn: () => ipc.savedRequests.list() });
  const templates = (templatesQuery.data?.requests ?? []).filter((r) => r.mode === SavedRequestMode.Request);
  const [loadedTemplateId, setLoadedTemplateId] = useState<string | null>(null);
  const [savingAs, setSavingAs] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const loadedTemplate = templates.find((t) => t.id === loadedTemplateId) ?? null;

  const invalidateTemplates = (): void => void qc.invalidateQueries({ queryKey: SAVED_REQUESTS_KEY });
  const createTemplate = useMutation({
    mutationFn: (name: string) =>
      ipc.savedRequests.create({
        name,
        subject: subject.trim(),
        mode: SavedRequestMode.Request,
        payload,
        encoding,
        headers: parseHeaders(headersRaw),
        timeoutMs,
      }),
    onSuccess: (dto) => {
      invalidateTemplates();
      setSavingAs(false);
      setNewTemplateName("");
      setLoadedTemplateId(dto.id);
    },
  });
  const updateTemplate = useMutation({
    mutationFn: (dto: SavedRequestDto) => ipc.savedRequests.update(dto),
    onSuccess: invalidateTemplates,
  });
  const deleteTemplate = useMutation({
    mutationFn: (id: string) => ipc.savedRequests.delete(id),
    onSuccess: () => {
      invalidateTemplates();
      setLoadedTemplateId(null);
    },
  });

  const loadTemplate = (id: string): void => {
    const t = templates.find((r) => r.id === id);
    if (!t) return;
    setSubject(t.subject);
    setPayload(t.payload);
    setEncoding(t.encoding);
    setHeadersRaw(headersToRaw(t.headers));
    setTimeoutMs(t.timeoutMs || 2000);
    setLoadedTemplateId(t.id);
  };

  return (
    <SplitPane id="requestreply" className="h-full gap-4 p-4" initial={50} min={25} max={75} stackBelow={1024}>
      <Panel className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-3">
          <SectionLabel>Templates</SectionLabel>
          <Select
            className="max-w-[220px]"
            value={loadedTemplateId ?? ""}
            onChange={loadTemplate}
            options={templates.map((t) => ({ value: t.id, label: t.name, hint: t.subject }))}
            disabled={templates.length === 0}
            placeholder={templates.length === 0 ? "No saved templates" : "Load a template…"}
          />
          {loadedTemplate && (
            <>
              <Button
                size="sm"
                variant="outline"
                icon="check"
                disabled={updateTemplate.isPending}
                onClick={() =>
                  updateTemplate.mutate({
                    ...loadedTemplate,
                    subject: subject.trim(),
                    payload,
                    encoding,
                    headers: parseHeaders(headersRaw),
                    timeoutMs,
                  })
                }
              >
                Update “{loadedTemplate.name}”
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                aria-label="Delete template"
                onClick={() => {
                  void confirm({
                    title: `Delete saved template "${loadedTemplate.name}"?`,
                    description: "This cannot be undone.",
                    consequences: ["It will no longer appear here or in Saved Requests."],
                    confirmLabel: "Delete template",
                    confirmIcon: "trash",
                  }).then((ok) => {
                    if (ok) deleteTemplate.mutate(loadedTemplate.id);
                  });
                }}
              />
            </>
          )}
          {!savingAs ? (
            <Button size="sm" variant="outline" icon="plus" onClick={() => setSavingAs(true)}>
              Save as template
            </Button>
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                className="field h-8 w-40 text-xs"
                autoFocus
                value={newTemplateName}
                onChange={(e) => setNewTemplateName(e.target.value)}
                placeholder="Template name"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newTemplateName.trim()) createTemplate.mutate(newTemplateName.trim());
                  if (e.key === "Escape") setSavingAs(false);
                }}
              />
              <Button
                size="sm"
                disabled={newTemplateName.trim() === "" || createTemplate.isPending}
                onClick={() => createTemplate.mutate(newTemplateName.trim())}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSavingAs(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
        <label className="block space-y-1.5">
          <SectionLabel>Subject</SectionLabel>
          <input className="field" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="svc.echo" />
        </label>
        <label className="block space-y-1.5">
          <SectionLabel>Request payload</SectionLabel>
          <textarea
            className="field-mono min-h-[150px]"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5">
            <SectionLabel>Encoding</SectionLabel>
            <Select
              value={encoding}
              onChange={(v) => setEncoding(v as PayloadEncoding)}
              options={[
                { value: PayloadEncoding.Utf8, label: "UTF-8" },
                { value: PayloadEncoding.Base64, label: "Base64" },
              ]}
            />
          </label>
          <label className="block space-y-1.5">
            <SectionLabel>Timeout (ms)</SectionLabel>
            <input
              type="number"
              min={100}
              step={100}
              className="field tabular-nums"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Number(e.target.value) || 0)}
            />
          </label>
        </div>
        <label className="block space-y-1.5">
          <SectionLabel>Headers (one Key: Value per line)</SectionLabel>
          <textarea
            className="field-mono min-h-[56px]"
            value={headersRaw}
            onChange={(e) => setHeadersRaw(e.target.value)}
            placeholder="X-Trace-Id: abc123"
            spellCheck={false}
          />
        </label>
        <div className="flex items-center gap-3 pt-1">
          <Button icon="swap" iconClassName={request.isPending ? "animate-spin" : undefined} onClick={() => request.mutate()} disabled={request.isPending || subject.trim() === ""}>
            {request.isPending ? "Awaiting reply…" : "Send request"}
          </Button>
          {request.isError && <span className="text-xs text-danger">{errorMessage(request.error)}</span>}
        </div>
      </Panel>

      <Panel className="flex min-h-0 flex-col p-4">
        <SectionLabel>Reply</SectionLabel>
        {reply ? (
          <div className="mt-2 space-y-2">
            <MessageMeta view={reply} />
            <PayloadView view={reply} />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted">Send a request to see the decoded reply here.</p>
          </div>
        )}
      </Panel>
    </SplitPane>
  );
}
