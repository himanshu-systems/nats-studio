/**
 * The application's information architecture. Each item maps to a feature view.
 * `live` items have a working backend today; the rest render an honest
 * "coming in Phase N" scaffold (see `ComingSoon.tsx`) so the map is complete.
 */
export interface NavItem {
  id: string;
  label: string;
  icon: string;
  /** Backed by a working implementation now. */
  live?: boolean;
  /** Roadmap phase for not-yet-live features. */
  phase?: string;
  /** One-line description of what the view does / will do. */
  blurb: string;
  /** True if the view operates on the active connection. */
  requiresConnection?: boolean;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    id: "workspace",
    label: "Workspace",
    items: [
      {
        id: "overview",
        label: "Overview",
        icon: "dashboard",
        live: true,
        requiresConnection: true,
        blurb: "Server identity, JetStream, round-trip latency and connection health at a glance.",
      },
      {
        id: "connections",
        label: "Connections",
        icon: "link",
        live: true,
        blurb: "Create connection profiles and connect / disconnect from NATS servers.",
      },
    ],
  },
  {
    id: "monitoring",
    label: "Monitoring",
    items: [
      {
        id: "metrics",
        label: "Metrics",
        icon: "bolt",
        phase: "Phase 4",
        requiresConnection: true,
        blurb: "Live throughput dashboard — in/out msgs & bytes, streamed from server monitoring.",
      },
      {
        id: "services",
        label: "Services",
        icon: "grid",
        phase: "Phase 4",
        requiresConnection: true,
        blurb: "NATS micro-services explorer with ping, stats and schema discovery.",
      },
      {
        id: "health",
        label: "Health & Alerts",
        icon: "activity",
        phase: "Phase 4",
        requiresConnection: true,
        blurb: "Client-computed health from streams, consumers and topology, with alerting.",
      },
      {
        id: "latency",
        label: "Latency (RTT)",
        icon: "clock",
        phase: "Phase 4",
        requiresConnection: true,
        blurb: "Continuous server round-trip-time measurement and history.",
      },
    ],
  },
  {
    id: "streams",
    label: "JetStream",
    items: [
      {
        id: "streams",
        label: "Streams",
        icon: "database",
        phase: "Phase 3",
        requiresConnection: true,
        blurb: "App / KV / Object / System streams — create, edit, delete and purge (all, by-subject, keep-N, up-to-seq).",
      },
      {
        id: "consumers",
        label: "Consumers",
        icon: "layers",
        phase: "Phase 3",
        requiresConnection: true,
        blurb: "Per-stream consumer inspector — config, pending, ack floor and redelivery.",
      },
      {
        id: "kv",
        label: "Key-Value",
        icon: "key",
        phase: "Phase 3",
        requiresConnection: true,
        blurb: "Full KV bucket & key manager — get / put / history / watch.",
      },
      {
        id: "objectstore",
        label: "Object Store",
        icon: "cube",
        phase: "Phase 3",
        requiresConnection: true,
        blurb: "Object store browser — buckets, objects, upload and download.",
      },
      {
        id: "accounts",
        label: "Accounts",
        icon: "users",
        phase: "Phase 4",
        requiresConnection: true,
        blurb: "Accounts and live connections (connz) view.",
      },
      {
        id: "backup",
        label: "Backup & Restore",
        icon: "archive",
        phase: "Phase 5",
        requiresConnection: true,
        blurb: "Logical backup / restore of streams via message re-publish.",
      },
    ],
  },
  {
    id: "messages",
    label: "Messages",
    items: [
      {
        id: "livetail",
        label: "Live Tail",
        icon: "signal",
        live: true,
        requiresConnection: true,
        blurb: "Subscribe to subjects and watch messages stream in live, decoded and inspectable.",
      },
      {
        id: "publisher",
        label: "Publisher",
        icon: "send",
        live: true,
        requiresConnection: true,
        blurb: "Publish messages with templates, {{variables}}, headers, base64 and burst mode.",
      },
      {
        id: "requestreply",
        label: "Request–Reply",
        icon: "swap",
        live: true,
        requiresConnection: true,
        blurb: "Send a request and inspect the decoded reply, with a configurable timeout.",
      },
      {
        id: "browser",
        label: "Message Browser",
        icon: "inbox",
        phase: "Phase 3",
        requiresConnection: true,
        blurb: "Browse stored JetStream messages, paginated, with per-message delete.",
      },
      {
        id: "replay",
        label: "Replay Studio",
        icon: "replay",
        phase: "Phase 5",
        requiresConnection: true,
        blurb: "Re-publish stored messages with rate and subject-mapping control.",
      },
      {
        id: "consumerlab",
        label: "Consumer Lab",
        icon: "beaker",
        phase: "Phase 3",
        requiresConnection: true,
        blurb: "Pull-fetch messages and debug ack / nak / term interactively.",
      },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    items: [
      {
        id: "dlq",
        label: "Dead Letters",
        icon: "alert",
        phase: "Phase 5",
        requiresConnection: true,
        blurb: "Advisory-based poison-message analyzer — inspect, redeliver and purge.",
      },
    ],
  },
];

const ALL_ITEMS: NavItem[] = NAV.flatMap((s) => s.items);

export function findNavItem(id: string): NavItem | undefined {
  return ALL_ITEMS.find((i) => i.id === id);
}
