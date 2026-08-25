import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@bindings";
import { NAV, type NavItem } from "../nav";
import { useUiStore } from "../lib/uiStore";
import { Logo } from "./Logo";
import { Icon } from "./Icon";
import { cx } from "./ui";
import { UpdatesDialog } from "./UpdatesDialog";

/** Width bounds for the expanded sidebar, in px. */
const MIN_W = 180;
const MAX_W = 420;
const DEFAULT_W = 236;
const WIDTH_KEY = "ns.sidebar.width";


/** Left navigation: brand, grouped feature sections, and the app version. */
export function Sidebar(): JSX.Element {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const [updatesOpen, setUpdatesOpen] = useState(false);

  // Draggable width, remembered across sessions. Collapsed mode ignores it.
  const [width, setWidth] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem(WIDTH_KEY));
      return Number.isFinite(n) && n > 0 ? Math.min(MAX_W, Math.max(MIN_W, n)) : DEFAULT_W;
    } catch {
      return DEFAULT_W;
    }
  });
  const [dragging, setDragging] = useState(false);
  const asideRef = useRef<HTMLElement>(null);

  const applyWidth = useCallback((next: number) => {
    const w = Math.min(MAX_W, Math.max(MIN_W, next));
    setWidth(w);
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
    } catch {
      /* storage unavailable — resizing still works this session */
    }
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging]);

  const { data: info } = useQuery({ queryKey: ["app", "info"], queryFn: () => ipc.app.info() });

  return (
    <aside
      ref={asideRef}
      style={collapsed ? undefined : { width }}
      className={cx(
        "relative flex h-full flex-col border-r border-border bg-surface",
        collapsed ? "w-[64px] transition-[width] duration-200" : "",
        // no width transition while dragging, or the edge lags the pointer
        !collapsed && !dragging ? "transition-[width] duration-200" : "",
      )}
    >
      <div className="flex h-14 items-center gap-2.5 px-4">
        <Logo size={30} />
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold tracking-tight text-content">
              NATS <span className="text-brand-gradient">Studio</span>
            </div>
          </div>
        )}
      </div>

      <nav className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {NAV.map((section) => (
          <div key={section.id}>
            {!collapsed && (
              <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint">
                {section.label}
              </div>
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavButton
                  key={item.id}
                  item={item}
                  active={view === item.id}
                  collapsed={collapsed}
                  onClick={() => setView(item.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {!collapsed && info && (
        <button
          type="button"
          onClick={() => setUpdatesOpen(true)}
          title="About & check for updates"
          className="border-t border-border px-4 py-2.5 text-left text-[11px] text-faint transition-colors hover:bg-surface-2 hover:text-muted"
        >
          v{info.version} · {info.os}/{info.arch} · {info.buildChannel}
        </button>
      )}

      {info && (
        <UpdatesDialog
          open={updatesOpen}
          onClose={() => setUpdatesOpen(false)}
          version={info.version}
        />
      )}
      {!collapsed && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={Math.round(width)}
          aria-valuemin={MIN_W}
          aria-valuemax={MAX_W}
          title="Drag to resize · double-click to reset · arrow keys to nudge"
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture?.(e.pointerId);
            setDragging(true);
          }}
          onPointerMove={(e) => {
            if (!dragging) return;
            const left = asideRef.current?.getBoundingClientRect().left ?? 0;
            applyWidth(e.clientX - left);
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
              e.currentTarget.releasePointerCapture?.(e.pointerId);
            }
            setDragging(false);
          }}
          onDoubleClick={() => applyWidth(DEFAULT_W)}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 24 : 8;
            if (e.key === "ArrowLeft") applyWidth(width - step);
            else if (e.key === "ArrowRight") applyWidth(width + step);
            else if (e.key === "Home") applyWidth(MIN_W);
            else if (e.key === "End") applyWidth(MAX_W);
            else if (e.key === "Enter") applyWidth(DEFAULT_W);
            else return;
            e.preventDefault();
          }}
          className={cx(
            "absolute inset-y-0 right-0 z-10 w-1 translate-x-1/2 cursor-col-resize transition-colors focus:outline-none",
            dragging ? "bg-accent" : "bg-transparent hover:bg-accent/60 focus-visible:bg-accent",
          )}
        />
      )}
    </aside>
  );
}

function NavButton({
  item,
  active,
  collapsed,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? item.label : undefined}
      className={cx(
        "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
        collapsed && "justify-center px-0",
        active
          ? "bg-accent/10 text-accent"
          : "text-muted hover:bg-surface-2 hover:text-content",
      )}
    >
      <Icon name={item.icon} size={18} className={active ? "text-accent" : ""} />
      {!collapsed && <span className="flex-1 truncate text-left">{item.label}</span>}
      {!collapsed && !item.live && (
        <span className="h-1.5 w-1.5 rounded-full bg-warning/70" title="Coming soon" />
      )}
    </button>
  );
}
