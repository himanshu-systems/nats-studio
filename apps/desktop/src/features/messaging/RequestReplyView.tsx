import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ipc, PayloadEncoding, type MessageView } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Button, Panel, SectionLabel } from "../../components/ui";
import { Select } from "../../components/Select";
import { errorMessage, MessageMeta, parseHeaders, PayloadView } from "./message";

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

  return (
    <div className="mx-auto grid h-full max-w-5xl gap-4 overflow-auto p-4 lg:grid-cols-2">
      <Panel className="space-y-3 p-4">
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
          <Button icon="swap" onClick={() => request.mutate()} disabled={request.isPending || subject.trim() === ""}>
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
    </div>
  );
}
