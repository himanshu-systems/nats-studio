import type { ConnzDto } from "@bindings";

/** NATS connection kinds that are server-to-server plumbing (cluster routes,
 * superclusters, leaf nodes, the internal $SYS account) rather than an
 * application producing/consuming messages. */
const INTERNAL_KINDS = new Set(["route", "gateway", "leafnode", "system"]);

export interface ClientTraffic {
  inMsgs: number;
  outMsgs: number;
  inBytes: number;
  outBytes: number;
}

/** Sum in/out messages and bytes across genuine client connections only —
 * what applications actually published and consumed, excluding the server's
 * internal route/gateway/leafnode/system traffic. A connection with an
 * unknown or missing `kind` (older server versions that don't report it) is
 * counted as a client, so this degrades to "everything" rather than zero. */
export function sumClientTraffic(connz: ConnzDto | undefined): ClientTraffic {
  const totals: ClientTraffic = { inMsgs: 0, outMsgs: 0, inBytes: 0, outBytes: 0 };
  for (const c of connz?.connections ?? []) {
    if (INTERNAL_KINDS.has(c.kind.toLowerCase())) continue;
    totals.inMsgs += c.inMsgs;
    totals.outMsgs += c.outMsgs;
    totals.inBytes += c.inBytes;
    totals.outBytes += c.outBytes;
  }
  return totals;
}
