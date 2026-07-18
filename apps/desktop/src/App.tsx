import { useQuery } from "@tanstack/react-query";
import { ipc } from "@bindings";
import { ConnectionsView } from "@/features/connections/ConnectionsView";

/**
 * Phase 1 shell: a header with live `app_info`, and the Connections feature —
 * create a profile, connect to a NATS server, and watch status stream in over
 * the event bridge (no polling). Dockable multi-panel workspace (dockview,
 * ADR-0012) lands in a later phase.
 */
export default function App(): JSX.Element {
  const { data: info } = useQuery({
    queryKey: ["app", "info"],
    queryFn: () => ipc.app.info(),
  });

  return (
    <div className="flex h-full flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2.5">
          <div className="h-6 w-6 rounded-md bg-emerald-500" aria-hidden />
          <span className="text-sm font-semibold tracking-tight">NATS Studio</span>
        </div>
        {info && (
          <span className="text-xs opacity-50">
            v{info.version} · schema {info.appSchemaVersion} · {info.os}/{info.arch} ·{" "}
            {info.buildChannel}
          </span>
        )}
      </header>
      <main className="min-h-0 flex-1 overflow-hidden">
        <ConnectionsView />
      </main>
    </div>
  );
}
