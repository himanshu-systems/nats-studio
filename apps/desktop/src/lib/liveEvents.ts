import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onAppEvent } from "@bindings";

/** Shared TanStack Query keys. */
export const CONNECTIONS_KEY = ["connection", "list"] as const;
export const PROFILES_KEY = ["connection", "profiles"] as const;

/**
 * Poll interval for server-owned resource lists (streams, consumers, buckets).
 *
 * These need an explicit interval because `App` keeps every visited view
 * mounted, so `refetchOnMount` fires exactly once — without polling, a list
 * fetched before JetStream was ready (or during a reconnect) would stay empty
 * forever, and resources created elsewhere would never show up. `retry: false`
 * is set globally, so this is also what lets a one-off IPC error self-heal.
 */
export const LIST_REFETCH_MS = 10_000;

/**
 * Invalidate connection queries whenever the backend emits any bus event
 * (bridged over `ns://event`). Push-based — no polling. Mount once near the root.
 */
export function useLiveEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const unlisten = onAppEvent(() => {
      void qc.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      void qc.invalidateQueries({ queryKey: PROFILES_KEY });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [qc]);
}
