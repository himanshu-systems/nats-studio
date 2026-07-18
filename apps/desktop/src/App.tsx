import { useUiStore } from "@/lib/uiStore";
import { useActiveConnection } from "@/lib/activeConnection";
import { useLiveEvents } from "@/lib/liveEvents";
import { findNavItem } from "@/nav";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { ComingSoon } from "@/components/ComingSoon";
import { OverviewView } from "@/features/overview/OverviewView";
import { ConnectionsView } from "@/features/connections/ConnectionsView";
import { PublisherView } from "@/features/messaging/PublisherView";
import { RequestReplyView } from "@/features/messaging/RequestReplyView";
import { LiveTailView } from "@/features/messaging/LiveTailView";

/** Render the feature view for the active nav id (falling back to a scaffold). */
function renderView(view: string): JSX.Element {
  switch (view) {
    case "overview":
      return <OverviewView />;
    case "connections":
      return <ConnectionsView />;
    case "publisher":
      return <PublisherView />;
    case "requestreply":
      return <RequestReplyView />;
    case "livetail":
      return <LiveTailView />;
    default: {
      const item = findNavItem(view);
      return item ? <ComingSoon item={item} /> : <OverviewView />;
    }
  }
}

/**
 * Application shell: sidebar navigation + top bar + the active feature view.
 * Connection-scoped views are keyed by the active connection id, so switching
 * connections gives each one its own fresh, isolated view state.
 */
export default function App(): JSX.Element {
  useLiveEvents();
  const view = useUiStore((s) => s.view);
  const { activeId } = useActiveConnection();
  const item = findNavItem(view);
  const scoped = item?.requiresConnection ?? false;
  const contentKey = scoped ? `${view}:${activeId ?? "none"}` : view;

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-hidden">
          <div key={contentKey} className="h-full animate-fade-in">
            {renderView(view)}
          </div>
        </main>
      </div>
    </div>
  );
}
