import { useQuery } from "@tanstack/react-query";
import { ipc, NatsStudioError } from "@bindings";

/**
 * Phase 0 shell: an empty window that performs the first real IPC round-trip
 * (`app_info`) through the typed bindings. The dockable multi-panel workspace
 * (dockview, ADR-0012) and the feature views land in Phase 1+.
 */
export default function App() {
  const { data, error, isPending } = useQuery({
    queryKey: ["app", "info"],
    queryFn: () => ipc.app.info(),
  });

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 rounded-lg bg-emerald-500" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight">NATS Studio</h1>
      </div>

      {isPending && <p className="text-sm opacity-60">Connecting to the backend…</p>}

      {error && (
        <p className="text-sm text-red-500">
          {error instanceof NatsStudioError ? `${error.code}: ${error.message}` : String(error)}
        </p>
      )}

      {data && (
        <p className="text-xs opacity-70">
          v{data.version} · schema {data.appSchemaVersion} · plugin API {data.pluginApiVersion} ·{" "}
          {data.os}/{data.arch} · {data.buildChannel}
        </p>
      )}
    </div>
  );
}
