import { useState } from "react";
import { explainError } from "../features/messaging/message";
import { Icon } from "./Icon";
import { cx } from "./ui";

/** A failed IPC call, explained: a friendly one-line summary + what to do,
 * with the full raw error (code, message, cause chain) available behind a
 * "Show details" toggle for anyone who needs the exact underlying reason. */
export function ErrorNote({ error, className }: { error: unknown; className?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { summary, hint, detail } = explainError(error);

  return (
    <div className={cx("rounded-lg border border-danger/25 bg-danger/10 p-2.5 text-xs", className)}>
      <div className="flex items-start gap-2">
        <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-content">{summary}</p>
          <p className="mt-0.5 text-muted">{hint}</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted transition-colors hover:text-content"
        >
          Details
          <Icon name="chevron-down" size={12} className={cx("transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {open && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-2 font-mono text-[11px] text-content">
          {detail}
        </pre>
      )}
    </div>
  );
}
