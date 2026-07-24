import { useQuery } from "@tanstack/react-query";
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

/**
 * The monitoring base URL for the active connection: the profile's configured
 * `monitorUrl` if set (Connections → edit profile), otherwise derived from the
 * connection's host. Read-only by design — the URL is a property of the
 * connection, set once there, not re-entered per view.
 */
export function useMonitorUrl(): { url: string; isCustom: boolean } {
  const { active } = useActiveConnection();
  const profiles = useQuery({
    queryKey: ["connection", "profiles"],
    queryFn: () => ipc.connection.listProfiles(),
  });
  const profile = profiles.data?.profiles.find((p) => p.id === active?.profileId);
  const custom = profile?.monitorUrl?.trim();
  return { url: custom || monitorBase(profile?.servers), isCustom: Boolean(custom) };
}
