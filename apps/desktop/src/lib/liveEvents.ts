import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onAppEvent } from "@bindings";

/** Shared TanStack Query keys. */
export const CONNECTIONS_KEY = ["connection", "list"] as const;
export const PROFILES_KEY = ["connection", "profiles"] as const;

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
