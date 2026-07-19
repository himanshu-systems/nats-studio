import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { Button, cx } from "./ui";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; downloaded: number; total: number }
  | { kind: "installing" }
  | { kind: "error"; message: string };

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * About + auto-update dialog. Drives the Tauri updater flow:
 * idle → checking → (up-to-date | available) → downloading → installing → relaunch,
 * with a friendly error state (no network / no published release yet).
 */
export function UpdatesDialog({
  open,
  onClose,
  version,
}: {
  open: boolean;
  onClose: () => void;
  version: string;
}): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  // Fresh state each time the dialog opens.
  useEffect(() => {
    if (open) setPhase({ kind: "idle" });
  }, [open]);

  // Escape to close (except while installing, when closing would be surprising).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && phase.kind !== "installing") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, phase.kind, onClose]);

  const runCheck = useCallback(async () => {
    setPhase({ kind: "checking" });
    try {
      const update = await check();
      setPhase(update ? { kind: "available", update } : { kind: "up-to-date" });
    } catch (e) {
      setPhase({ kind: "error", message: errMessage(e) });
    }
  }, []);

  const runInstall = useCallback(async (update: Update) => {
    let downloaded = 0;
    let total = 0;
    setPhase({ kind: "downloading", update, downloaded, total });
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            setPhase({ kind: "downloading", update, downloaded, total });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setPhase({ kind: "downloading", update, downloaded, total });
            break;
          case "Finished":
            setPhase({ kind: "installing" });
            break;
        }
      });
      await relaunch();
    } catch (e) {
      setPhase({ kind: "error", message: errMessage(e) });
    }
  }, []);

  if (!open) return null;
  const busy = phase.kind === "checking" || phase.kind === "downloading" || phase.kind === "installing";

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="About NATS Studio"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-border bg-surface shadow-panel"
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <Logo size={30} />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-sm font-semibold tracking-tight text-content">
              NATS <span className="text-brand-gradient">Studio</span>
            </div>
            <div className="text-[11px] text-faint">Version {version}</div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
            className="text-muted transition-colors hover:text-content disabled:opacity-40"
          >
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <p className="text-sm leading-relaxed text-muted">
            A desktop workbench for NATS — connect, publish, subscribe, and inspect streams and
            services across your clusters.
          </p>

          <PhaseView phase={phase} onCheck={runCheck} onInstall={runInstall} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PhaseView({
  phase,
  onCheck,
  onInstall,
}: {
  phase: Phase;
  onCheck: () => void;
  onInstall: (update: Update) => void;
}): JSX.Element {
  switch (phase.kind) {
    case "idle":
      return (
        <Button variant="primary" icon="replay" onClick={onCheck}>
          Check for updates
        </Button>
      );

    case "checking":
      return (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Icon name="replay" size={16} className="animate-spin" />
          Checking for updates…
        </div>
      );

    case "up-to-date":
      return (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-positive">
            <Icon name="check" size={16} />
            You&apos;re on the latest version.
          </div>
          <Button variant="outline" size="sm" onClick={onCheck}>
            Check again
          </Button>
        </div>
      );

    case "available":
      return (
        <UpdateCard update={phase.update} onInstall={() => onInstall(phase.update)} />
      );

    case "downloading": {
      const pct = phase.total > 0 ? Math.round((phase.downloaded / phase.total) * 100) : null;
      return (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm text-muted">
            <span>Downloading update…</span>
            {pct !== null && <span className="tabular-nums text-content">{pct}%</span>}
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className={cx("h-full rounded-full bg-accent transition-[width]", pct === null && "animate-pulse")}
              style={{ width: pct !== null ? `${pct}%` : "100%" }}
            />
          </div>
        </div>
      );
    }

    case "installing":
      return (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Icon name="replay" size={16} className="animate-spin" />
          Installing — the app will restart…
        </div>
      );

    case "error":
      return (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
            <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium">Couldn&apos;t check for updates.</div>
              <div className="mt-0.5 break-words text-[12px] text-danger/80">{phase.message}</div>
            </div>
          </div>
          <Button variant="outline" size="sm" icon="replay" onClick={onCheck}>
            Try again
          </Button>
        </div>
      );
  }
}

function UpdateCard({ update, onInstall }: { update: Update; onInstall: () => void }): JSX.Element {
  return (
    <div className="space-y-3 rounded-lg border border-accent/25 bg-accent/10 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-content">
          Update available — v{update.version}
        </div>
        {update.date && <span className="text-[11px] text-faint">{update.date.split(" ")[0]}</span>}
      </div>
      {update.body && (
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted">
          {update.body}
        </pre>
      )}
      <Button variant="primary" size="sm" onClick={onInstall}>
        Download &amp; install
      </Button>
    </div>
  );
}
