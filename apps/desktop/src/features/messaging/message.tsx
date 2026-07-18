import { useState } from "react";
import type { MessageView, MessageHeader } from "@bindings";
import { NatsStudioError } from "@bindings";
import { Badge, cx } from "../../components/ui";
import { Icon } from "../../components/Icon";

export function errorMessage(e: unknown): string {
  if (e instanceof NatsStudioError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** Parse a `Key: Value` per-line textarea into wire headers, skipping blanks. */
export function parseHeaders(raw: string): MessageHeader[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes(":"))
    .map((line) => {
      const idx = line.indexOf(":");
      return { name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
    })
    .filter((h) => h.name.length > 0);
}

const FORMAT_TONE: Record<string, "accent" | "positive" | "neutral" | "warning"> = {
  json: "accent",
  text: "positive",
  binary: "warning",
  empty: "neutral",
};

/** Compact one-line metadata row for a decoded message. */
export function MessageMeta({ view }: { view: MessageView }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      <span className="font-medium text-content">{view.subject}</span>
      <Badge tone={FORMAT_TONE[view.format] ?? "neutral"}>{view.format}</Badge>
      <span className="tabular-nums">{view.size} B</span>
      {view.compression !== "none" && <Badge tone="warning">{view.compression}</Badge>}
      {view.reply && <span className="truncate">reply → {view.reply}</span>}
      <span className="text-faint">{new Date(view.ts).toLocaleTimeString()}</span>
    </div>
  );
}

/** Payload viewer with a copy button and optional headers table. */
export function PayloadView({
  view,
  className,
}: {
  view: MessageView;
  className?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard.writeText(view.preview).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className={cx("space-y-2", className)}>
      {view.headers.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg border border-border bg-surface-2 p-2 text-xs">
          {view.headers.map((h, i) => (
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
          {view.preview || <span className="text-faint">(empty payload)</span>}
        </pre>
      </div>
    </div>
  );
}
