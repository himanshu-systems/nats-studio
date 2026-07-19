import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@bindings";
import { NAV, type NavItem } from "../nav";
import { useUiStore } from "../lib/uiStore";
import { Logo } from "./Logo";
import { Icon } from "./Icon";
import { cx } from "./ui";
import { UpdatesDialog } from "./UpdatesDialog";

/** Left navigation: brand, grouped feature sections, and the app version. */
export function Sidebar(): JSX.Element {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const [updatesOpen, setUpdatesOpen] = useState(false);

  const { data: info } = useQuery({ queryKey: ["app", "info"], queryFn: () => ipc.app.info() });

  return (
    <aside
      className={cx(
        "flex h-full flex-col border-r border-border bg-surface transition-[width] duration-200",
        collapsed ? "w-[64px]" : "w-[236px]",
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
