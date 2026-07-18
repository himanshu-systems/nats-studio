import { useEffect, useState } from "react";
import { useUiStore } from "@/lib/uiStore";
import { useActiveConnection } from "@/lib/activeConnection";
import { useLiveEvents } from "@/lib/liveEvents";
import { findNavItem } from "@/nav";
import { cx } from "@/components/ui";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { ComingSoon } from "@/components/ComingSoon";
import { OverviewView } from "@/features/overview/OverviewView";
import { ConnectionsView } from "@/features/connections/ConnectionsView";
import { PublisherView } from "@/features/messaging/PublisherView";
import { RequestReplyView } from "@/features/messaging/RequestReplyView";
import { LiveTailView } from "@/features/messaging/LiveTailView";
import { StreamsView } from "@/features/jetstream/StreamsView";
import { ConsumersView } from "@/features/jetstream/ConsumersView";
import { KvView } from "@/features/jetstream/KvView";
import { ObjectStoreView } from "@/features/jetstream/ObjectStoreView";
import { MessageBrowserView } from "@/features/jetstream/MessageBrowserView";
import { ConsumerLabView } from "@/features/jetstream/ConsumerLabView";
import { MetricsView } from "@/features/monitoring/MetricsView";
import { ServicesView } from "@/features/services/ServicesView";
import { DlqView } from "@/features/admin/DlqView";

/** Render the feature view for the active nav id (falling back to a scaffold). */
function renderView(view: string): JSX.Element {
  switch (view) {
    case "overview":
      return <OverviewView />;
    case "connections":
      return <ConnectionsView />;
    case "streams":
      return <StreamsView />;
    case "consumers":
      return <ConsumersView />;
    case "kv":
      return <KvView />;
    case "objectstore":
      return <ObjectStoreView />;
    case "livetail":
      return <LiveTailView />;
    case "publisher":
      return <PublisherView />;
    case "requestreply":
      return <RequestReplyView />;
    case "browser":
      return <MessageBrowserView />;
    case "consumerlab":
      return <ConsumerLabView />;
    case "dlq":
      return <DlqView />;
    case "metrics":
      return <MetricsView />;
    case "services":
      return <ServicesView />;
    default: {
      const item = findNavItem(view);
      return item ? <ComingSoon item={item} /> : <OverviewView />;
    }
  }
}

/** Instance key for a view: connection-scoped views get their own instance per
 *  connection (isolation); global views are shared. */
function instanceKey(id: string, activeId: string | null): string {
  return findNavItem(id)?.requiresConnection ? `${id}::${activeId ?? "none"}` : id;
}

/**
 * Application shell: sidebar navigation + top bar + the active feature view.
 *
 * Views are kept alive: once visited, each (view × connection) instance stays
 * mounted and is merely hidden when inactive, so state persists across tab
 * navigation — Dead Letters keeps listening, Live Tail keeps its messages,
 * forms keep their input. Switching the active connection still gives
 * connection-scoped views their own isolated instance.
 */
export default function App(): JSX.Element {
  useLiveEvents();
  const view = useUiStore((s) => s.view);
  const { activeId } = useActiveConnection();
  const activeKey = instanceKey(view, activeId);

  // Remember every instance we've shown, so it stays mounted (hidden) afterward.
  const [mounted, setMounted] = useState<Record<string, string>>({ [activeKey]: view });
  useEffect(() => {
    setMounted((m) => (m[activeKey] ? m : { ...m, [activeKey]: view }));
  }, [activeKey, view]);

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="relative min-h-0 flex-1 overflow-hidden">
          {Object.entries(mounted).map(([key, id]) => (
            <div
              key={key}
              className={cx("absolute inset-0", key === activeKey ? "animate-fade-in" : "hidden")}
            >
              {renderView(id)}
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}
