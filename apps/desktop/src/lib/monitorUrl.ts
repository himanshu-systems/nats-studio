import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { ipc } from "@bindings";
import { useActiveConnection } from "./activeConnection";

/**
 * Derive the HTTP monitoring base URL (`http://<host>:8222`) from a connection's
 * configured server URL. The NATS `INFO` handshake reports the server's *listen*
 * host (often `0.0.0.0`), which isn't reachable — so we take the host the user
 * actually connected to and assume the conventional monitoring port 8222.
 */
export function monitorBase(servers?: string[]): string {
  const raw = (servers?.[0] ?? "").trim();
  let host = (raw
    .replace(/^[a-z0-9+.-]+:\/\//i, "") // strip scheme (nats://, tls://, …)
    .split(",")[0] ?? "")
    .split("/")[0]
    ?.trim() ?? "";
  if (host.startsWith("[")) {
    // IPv6 literal, e.g. [::1]:4222
    const end = host.indexOf("]");
    host = end > 0 ? host.slice(1, end) : host.slice(1);
  } else if (host.includes(":")) {
    host = host.slice(0, host.lastIndexOf(":"));
  }
  if (host === "" || host === "0.0.0.0") host = "127.0.0.1";
  return `http://${host}:8222`;
}

// Per-connection user override of the monitoring URL, shared across views so the
// Overview and Metrics screens stay in sync when one edits the endpoint.
interface OverrideState {
  byConn: Record<string, string>;
  set: (connId: string, url: string) => void;
}
const useOverride = create<OverrideState>((set) => ({
  byConn: {},
  set: (connId, url) => set((s) => ({ byConn: { ...s.byConn, [connId]: url } })),
}));

/**
 * The monitoring base URL for the active connection: the per-connection override
 * if the user set one, otherwise derived from the connection's host. Editing it
 * (via `setUrl`) is shared between the Overview and Metrics views.
 */
export function useMonitorUrl(): { url: string; derived: string; setUrl: (url: string) => void } {
  const { active } = useActiveConnection();
  const connId = active?.connectionId ?? "";
  const profiles = useQuery({
    queryKey: ["connection", "profiles"],
    queryFn: () => ipc.connection.listProfiles(),
  });
  const profile = profiles.data?.profiles.find((p) => p.id === active?.profileId);
  const derived = monitorBase(profile?.servers);
  const override = useOverride((s) => (connId ? s.byConn[connId] : undefined));
  const setOverride = useOverride((s) => s.set);
  return {
    url: override ?? derived,
    derived,
    setUrl: (url: string) => connId && setOverride(connId, url),
  };
}
