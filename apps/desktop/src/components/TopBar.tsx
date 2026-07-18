import { useState } from "react";
import { ConnectionStatus } from "@bindings";
import { useUiStore } from "../lib/uiStore";
import { useActiveConnection } from "../lib/activeConnection";
import { useTheme } from "../lib/theme";
import { findNavItem } from "../nav";
import { Icon } from "./Icon";
import { cx, IconButton, StatusDot, statusMeta } from "./ui";

/** Top bar: sidebar toggle, view title, connection switcher, theme toggle. */
export function TopBar(): JSX.Element {
  const view = useUiStore((s) => s.view);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const item = findNavItem(view);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
      <IconButton icon="panel-left" label="Toggle sidebar" onClick={toggleSidebar} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-sm font-semibold text-content">{item?.label ?? "NATS Studio"}</h1>
        </div>
        {item?.blurb && <p className="truncate text-xs text-muted">{item.blurb}</p>}
      </div>
      <ConnectionSwitcher />
      <ThemeToggle />
    </header>
  );
}

function ConnectionSwitcher(): JSX.Element {
  const { connections, active, setActiveId } = useActiveConnection();
  const setView = useUiStore((s) => s.setView);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm transition-colors hover:bg-surface-2"
      >
        {active ? (
          <>
            <StatusDot status={active.status} />
            <span className="max-w-[160px] truncate font-medium text-content">{active.name}</span>
          </>
        ) : (
          <span className="text-muted">No connection</span>
        )}
        <Icon name="chevron-down" size={15} className="text-faint" />
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-11 z-50 w-72 animate-fade-in rounded-xl border border-border bg-overlay p-1.5 shadow-pop">
            <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
              Active connection
            </div>
            {connections.length === 0 && (
              <p className="px-2.5 py-2 text-xs text-muted">
                No connections yet. Create a profile and connect.
              </p>
            )}
            {connections.map((c) => {
              const meta = statusMeta(c.status);
              return (
                <button
                  key={c.connectionId}
                  type="button"
                  onClick={() => {
                    setActiveId(c.connectionId);
                    setOpen(false);
                  }}
                  className={cx(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-surface-2",
                    active?.connectionId === c.connectionId && "bg-surface-2",
                  )}
                >
                  <StatusDot status={c.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-content">{c.name}</span>
                    <span className="block truncate text-xs text-muted">{meta.label}</span>
                  </span>
                  {c.status === ConnectionStatus.Connected && c.rttMs != null && (
                    <span className="text-xs tabular-nums text-faint">{c.rttMs} ms</span>
                  )}
                </button>
              );
            })}
            <div className="mt-1 border-t border-border pt-1">
              <button
                type="button"
                onClick={() => {
                  setView("connections");
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-accent transition-colors hover:bg-surface-2"
              >
                <Icon name="plus" size={16} /> Manage connections
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ThemeToggle(): JSX.Element {
  const { resolved, toggle } = useTheme();
  return (
    <IconButton
      icon={resolved === "dark" ? "sun" : "moon"}
      label={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggle}
    />
  );
}
