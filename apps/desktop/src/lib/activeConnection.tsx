import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ConnectionStatus, ipc, type ConnectionSummary } from "@bindings";
import { CONNECTIONS_KEY } from "./liveEvents";

interface ActiveConnectionValue {
  /** All live connections (any status). */
  connections: ConnectionSummary[];
  /** The connection every feature view is currently scoped to. */
  active: ConnectionSummary | null;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  isConnected: boolean;
}

const Ctx = createContext<ActiveConnectionValue | null>(null);

/**
 * Holds the *active* connection — the workspace's isolation boundary. Every
 * feature operates on this one connection; switching it (via the top-bar
 * switcher) re-scopes the whole workspace. The content area is keyed by
 * `activeId`, so each connection gets its own fresh, isolated view state.
 */
export function ActiveConnectionProvider({ children }: { children: ReactNode }): JSX.Element {
  const { data } = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: () => ipc.connection.list(),
    refetchInterval: 5000,
  });
  const connections = useMemo(() => data?.connections ?? [], [data]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Keep the selection valid; prefer a connected one when (re)selecting.
  useEffect(() => {
    if (connections.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (activeId === null || !connections.some((c) => c.connectionId === activeId)) {
      const fallback =
        connections.find((c) => c.status === ConnectionStatus.Connected) ?? connections[0];
      if (fallback) setActiveId(fallback.connectionId);
    }
  }, [connections, activeId]);

  const active = connections.find((c) => c.connectionId === activeId) ?? null;
  const value: ActiveConnectionValue = {
    connections,
    active,
    activeId,
    setActiveId,
    isConnected: active?.status === ConnectionStatus.Connected,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useActiveConnection(): ActiveConnectionValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useActiveConnection must be used within an ActiveConnectionProvider");
  return ctx;
}
