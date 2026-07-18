import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@bindings";
import { ConnectionsView } from "@/features/connections/ConnectionsView";
import { MessagingView } from "@/features/messaging/MessagingView";

type View = "connections" | "messaging";

const TABS: ReadonlyArray<{ id: View; label: string }> = [
  { id: "connections", label: "Connections" },
  { id: "messaging", label: "Messaging" },
];

/**
 * Application shell: a header with live `app_info`, a primary nav that switches
 * between feature workspaces, and the active feature view. Phase 1 shipped
 * Connections; Phase 2 adds Messaging (publish / request / subscribe). A dockable
 * multi-panel workspace (dockview, ADR-0012) lands in a later phase.
 */
export default function App(): JSX.Element {
  const [view, setView] = useState<View>("connections");
  const { data: info } = useQuery({
    queryKey: ["app", "info"],
    queryFn: () => ipc.app.info(),
  });

  return (
    <div className="flex h-full flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-2.5">
            <div className="h-6 w-6 rounded-md bg-emerald-500" aria-hidden />
            <span className="text-sm font-semibold tracking-tight">NATS Studio</span>
          </div>
          <nav className="flex items-center gap-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setView(tab.id)}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                  view === tab.id
                    ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                    : "opacity-60 hover:bg-slate-100 hover:opacity-100 dark:hover:bg-slate-800"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
        {info && (
          <span className="text-xs opacity-50">
            v{info.version} · schema {info.appSchemaVersion} · {info.os}/{info.arch} ·{" "}
            {info.buildChannel}
          </span>
        )}
      </header>
      <main className="min-h-0 flex-1 overflow-hidden">
        {view === "connections" ? <ConnectionsView /> : <MessagingView />}
      </main>
    </div>
  );
}
