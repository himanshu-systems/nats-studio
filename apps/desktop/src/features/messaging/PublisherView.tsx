import { useState } from "react";
import { ipc, PayloadEncoding } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Button, Panel, SectionLabel } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { Select } from "../../components/Select";
import { errorMessage, parseHeaders } from "./message";

interface Var {
  name: string;
  value: string;
}

interface SentEntry {
  id: number;
  subject: string;
  count: number;
  ok: boolean;
  detail: string;
}

/** Expand `{{name}}` placeholders using built-ins and user variables. */
function renderTemplate(tpl: string, vars: Var[], seq: number): string {
  const lookup = new Map(vars.map((v) => [v.name, v.value]));
  return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, name: string) => {
    switch (name) {
      case "uuid":
        return crypto.randomUUID();
      case "timestamp":
        return new Date().toISOString();
      case "epoch":
        return String(Date.now());
      case "seq":
        return String(seq);
      case "random":
        return String(Math.floor(Math.random() * 1_000_000_000));
      default:
        return lookup.get(name) ?? "";
    }
  });
}

export function PublisherView(): JSX.Element {
  return <RequireConnection>{(connId) => <Publisher connId={connId} />}</RequireConnection>;
}

function Publisher({ connId }: { connId: string }): JSX.Element {
  const [subject, setSubject] = useState("demo.subject");
  const [template, setTemplate] = useState('{\n  "id": "{{uuid}}",\n  "n": {{seq}},\n  "at": "{{timestamp}}"\n}');
  const [encoding, setEncoding] = useState<PayloadEncoding>(PayloadEncoding.Utf8);
  const [headersRaw, setHeadersRaw] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [vars, setVars] = useState<Var[]>([]);
  const [burst, setBurst] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SentEntry[]>([]);
  const [nextId, setNextId] = useState(1);

  const setVar = (i: number, patch: Partial<Var>): void =>
    setVars((prev) => prev.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  const publish = async (): Promise<void> => {
    const subj = subject.trim();
    if (subj === "") return;
    const count = Math.max(1, Math.min(burst, 100_000));
    setBusy(true);
    setError(null);
    const headers = parseHeaders(headersRaw);
    const reply = replyTo.trim() === "" ? undefined : replyTo.trim();
    try {
      for (let i = 1; i <= count; i++) {
        const payload = renderTemplate(template, vars, i);
        await ipc.pubsub.publish({ connectionId: connId, subject: subj, payload, encoding, headers, reply });
      }
      const entry: SentEntry = {
        id: nextId,
        subject: subj,
        count,
        ok: true,
        detail: count > 1 ? `${count} messages` : "1 message",
      };
      setSent((prev) => [entry, ...prev].slice(0, 30));
      setNextId((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto grid h-full max-w-5xl grid-rows-[1fr] gap-4 overflow-auto p-4 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4">
        <Panel className="space-y-3 p-4">
          <label className="block space-y-1.5">
            <SectionLabel>Subject</SectionLabel>
            <input className="field" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="orders.new" />
          </label>

          <label className="block space-y-1.5">
            <div className="flex items-center justify-between">
              <SectionLabel>Payload template</SectionLabel>
              <span className="text-[11px] text-faint">
                supports <code className="font-mono">{"{{uuid}}"}</code>{" "}
                <code className="font-mono">{"{{seq}}"}</code>{" "}
                <code className="font-mono">{"{{timestamp}}"}</code>{" "}
                <code className="font-mono">{"{{epoch}}"}</code>{" "}
                <code className="font-mono">{"{{random}}"}</code>
              </span>
            </div>
            <textarea
              className="field-mono min-h-[150px]"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              spellCheck={false}
            />
          </label>

          <div className="grid grid-cols-3 gap-3">
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
              <SectionLabel>Reply-to</SectionLabel>
              <input className="field" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="(optional)" />
            </label>
            <label className="block space-y-1.5">
              <SectionLabel>Burst count</SectionLabel>
              <input
                type="number"
                min={1}
                max={100000}
                className="field tabular-nums"
                value={burst}
                onChange={(e) => setBurst(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
          </div>

          <label className="block space-y-1.5">
            <SectionLabel>Headers (one Key: Value per line)</SectionLabel>
            <textarea
              className="field-mono min-h-[56px]"
              value={headersRaw}
              onChange={(e) => setHeadersRaw(e.target.value)}
              placeholder="X-Trace-Id: {{uuid}}"
              spellCheck={false}
            />
          </label>

          <div className="flex items-center gap-3 pt-1">
            <Button icon="send" onClick={() => void publish()} disabled={busy || subject.trim() === ""}>
              {busy ? "Publishing…" : burst > 1 ? `Publish ${burst}×` : "Publish"}
            </Button>
            {error && <span className="text-xs text-danger">{error}</span>}
          </div>
        </Panel>

        <VariablesPanel vars={vars} setVars={setVars} setVar={setVar} />
      </div>

      <Panel className="flex min-h-0 flex-col p-0">
        <div className="border-b border-border px-3 py-2">
          <SectionLabel>Recent sends</SectionLabel>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {sent.length === 0 ? (
            <p className="p-3 text-xs text-muted">Nothing published yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {sent.map((s) => (
                <li key={s.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs">
                  <Icon name="check" size={14} className="text-positive" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-content">{s.subject}</span>
                    <span className="text-muted">{s.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>
    </div>
  );
}

function VariablesPanel({
  vars,
  setVars,
  setVar,
}: {
  vars: Var[];
  setVars: React.Dispatch<React.SetStateAction<Var[]>>;
  setVar: (i: number, patch: Partial<Var>) => void;
}): JSX.Element {
  return (
    <Panel className="space-y-2 p-4">
      <div className="flex items-center justify-between">
        <SectionLabel>Variables</SectionLabel>
        <Button size="sm" variant="outline" icon="plus" onClick={() => setVars((p) => [...p, { name: "", value: "" }])}>
          Add
        </Button>
      </div>
      {vars.length === 0 && (
        <p className="text-xs text-muted">
          Define reusable <code className="font-mono">{"{{name}}"}</code> values referenced by the template.
        </p>
      )}
      {vars.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <input className="field" placeholder="name" value={v.name} onChange={(e) => setVar(i, { name: e.target.value })} />
          <input className="field" placeholder="value" value={v.value} onChange={(e) => setVar(i, { value: e.target.value })} />
          <button
            type="button"
            aria-label="Remove variable"
            onClick={() => setVars((p) => p.filter((_, j) => j !== i))}
            className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-danger"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
    </Panel>
  );
}
