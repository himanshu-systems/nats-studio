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
      {
        id: "topology",
        label: "Topology",
        icon: "network",
        live: true,
        requiresConnection: true,
        blurb: "Streams and the subjects they capture, the server in use, and per-client subscriber counts.",
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
        live: true,
        blurb: "Live throughput dashboard — in/out msgs & bytes, from the server monitoring endpoint.",
      },
      {
        id: "services",
        label: "Services",
        icon: "grid",
        live: true,
        requiresConnection: true,
        blurb: "NATS micro-services explorer with ping, stats and schema discovery.",
      },
      {
        id: "health",
        label: "Health & Alerts",
        icon: "activity",
        live: true,
        requiresConnection: true,
        blurb: "Client-computed health from streams, consumers and topology, with alerting.",
      },
      {
        id: "latency",
        label: "Latency (RTT)",
        icon: "clock",
        live: true,
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
        live: true,
        requiresConnection: true,
        blurb: "App / KV / Object / System streams — create, edit, delete and purge (all, by-subject, keep-N, up-to-seq).",
      },
      {
        id: "consumers",
        label: "Consumers",
        icon: "layers",
        live: true,
        requiresConnection: true,
        blurb: "Per-stream consumer inspector — config, pending, ack floor and redelivery.",
      },
      {
        id: "kv",
        label: "Key-Value",
        icon: "key",
        live: true,
        requiresConnection: true,
        blurb: "Full KV bucket & key manager — get / put / history / watch.",
      },
      {
        id: "objectstore",
        label: "Object Store",
        icon: "cube",
        live: true,
        requiresConnection: true,
        blurb: "Object store browser — buckets, objects, upload and download.",
      },
      {
        id: "accounts",
        label: "Accounts",
        icon: "users",
        live: true,
        blurb: "Live connections (connz) from the server monitoring endpoint.",
      },
      {
        id: "backup",
        label: "Backup & Restore",
        icon: "archive",
        live: true,
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
        live: true,
        requiresConnection: true,
        blurb: "Browse stored JetStream messages, paginated, with per-message delete.",
      },
      {
        id: "replay",
        label: "Replay Studio",
        icon: "replay",
        live: true,
        requiresConnection: true,
        blurb: "Re-publish stored messages with rate and subject-mapping control.",
      },
      {
        id: "consumerlab",
        label: "Consumer Lab",
        icon: "beaker",
        live: true,
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
        live: true,
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
