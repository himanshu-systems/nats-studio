import type { ReactNode } from "react";
import { useActiveConnection } from "../lib/activeConnection";
import { useUiStore } from "../lib/uiStore";
import { Button, EmptyState } from "./ui";

/**
 * Gate for connection-scoped features: renders `children` with the active
 * connection id only when one is connected, otherwise a prompt to connect.
 */
export function RequireConnection({
  children,
}: {
  children: (connectionId: string) => ReactNode;
}): JSX.Element {
  const { active, isConnected } = useActiveConnection();
  const setView = useUiStore((s) => s.setView);

  if (!active || !isConnected) {
    return (
      <EmptyState
        icon="link"
        title="No active connection"
        action={
          <Button icon="link" onClick={() => setView("connections")}>
            Go to Connections
          </Button>
        }
      >
        This feature works on a live connection. Connect to a NATS server, then pick it from the
        connection switcher in the top bar.
      </EmptyState>
    );
  }
  return <>{children(active.connectionId)}</>;
}
