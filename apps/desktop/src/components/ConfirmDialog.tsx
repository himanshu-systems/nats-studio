import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { Button } from "./ui";

export interface ConfirmOptions {
  /** Short question, e.g. `Delete stream "orders"?`. */
  title: string;
  /** One line of extra context under the title. */
  description?: string;
  /** Bullet list of concrete "what happens" consequences. */
  consequences?: string[];
  /** The action being taken, e.g. "Delete stream" / "Terminate" — required so
   *  every call site names its actual verb instead of a generic default. */
  confirmLabel: string;
  /** Icon on the confirm button, matching the button that triggered this (e.g.
   *  "trash" for deletes, "x" for terminate). */
  confirmIcon?: string;
  cancelLabel?: string;
  /** Styles the confirm button as danger (red). Default `true`. */
  danger?: boolean;
}

interface Pending {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

const Ctx = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

/**
 * App-wide confirmation dialog: `window.confirm` doesn't reliably block inside
 * Tauri's webview (it can resolve immediately without ever showing anything),
 * so irreversible actions render this real modal instead and await the user's
 * choice — with room to explain exactly what the action will do.
 */
export function ConfirmProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => setPending({ opts, resolve }));
  }, []);

  const settle = (ok: boolean): void => {
    pending?.resolve(ok);
    setPending(null);
  };

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") settle(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {pending &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
            onClick={() => settle(false)}
          >
            <div
              role="alertdialog"
              aria-modal="true"
              aria-label={pending.opts.title}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm rounded-xl border border-border bg-surface shadow-panel"
            >
              <div className="flex items-start gap-3 px-5 pt-5">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger">
                  <Icon name="alert" size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-content">{pending.opts.title}</div>
                  {pending.opts.description && (
                    <p className="mt-1 text-xs leading-relaxed text-muted">{pending.opts.description}</p>
                  )}
                </div>
              </div>

              {pending.opts.consequences && pending.opts.consequences.length > 0 && (
                <ul className="mx-5 mt-3 space-y-1 rounded-lg border border-danger/20 bg-danger/5 p-3 text-xs text-danger">
                  {pending.opts.consequences.map((c, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span aria-hidden>•</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex justify-end gap-2 px-5 py-4">
                <Button variant="outline" size="sm" onClick={() => settle(false)}>
                  {pending.opts.cancelLabel ?? "Cancel"}
                </Button>
                <Button
                  variant={pending.opts.danger === false ? "primary" : "danger"}
                  size="sm"
                  icon={pending.opts.confirmIcon}
                  onClick={() => settle(true)}
                >
                  {pending.opts.confirmLabel}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </Ctx.Provider>
  );
}

/** `await confirm({ title, description, consequences })` — resolves `true` if
 *  the user confirms, `false` on Cancel / Escape / backdrop click. */
export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useConfirm must be used within a ConfirmProvider");
  return ctx;
}
