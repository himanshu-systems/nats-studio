import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIST_REFETCH_MS } from "../../lib/liveEvents";

/**
 * `App` keeps every visited view mounted, so `refetchOnMount` fires exactly
 * once per view and the global config sets `refetchOnWindowFocus: false` +
 * `retry: false`. Without an explicit `refetchInterval`, a server-owned list
 * fetched before JetStream was ready (or during a reconnect) stays empty for
 * the rest of the session, and resources created elsewhere never appear —
 * which reads to a user as "it shows data sometimes and sometimes not".
 *
 * These are source-level assertions rather than render tests because the
 * failure mode is a missing query option, not wrong rendering.
 */
const HERE = join(__dirname);
const SRC = join(HERE, "..", "..");

const read = (rel: string): string => readFileSync(join(SRC, rel), "utf-8");

/** The IPC calls whose queries back a browsable list of server-owned resources. */
const LIST_QUERIES: Array<[file: string, ipcCall: string]> = [
  ["features/jetstream/StreamsView.tsx", "listStreams"],
  ["features/jetstream/ConsumersView.tsx", "listStreams"],
  ["features/jetstream/ConsumersView.tsx", "listConsumers"],
  ["features/jetstream/ConsumerLabView.tsx", "listStreams"],
  ["features/jetstream/ConsumerLabView.tsx", "listConsumers"],
  ["features/jetstream/MessageBrowserView.tsx", "listStreams"],
  ["features/jetstream/KvView.tsx", "listBuckets"],
  ["features/jetstream/KvView.tsx", "listKeys"],
  ["features/jetstream/ObjectStoreView.tsx", "listObjectBuckets"],
  ["features/jetstream/ObjectStoreView.tsx", "listObjects"],
];

/** Text of the `useQuery`/`useQueries` options object containing `ipcCall`. */
function optionsBlockFor(source: string, ipcCall: string): string {
  const at = source.indexOf(`ipc.jetstream.${ipcCall}(`);
  expect(at, `${ipcCall} should appear in the source`).toBeGreaterThan(-1);
  // Walk forward to the end of this options object — the next `});` or `})),`.
  const rest = source.slice(at);
  const end = rest.search(/\n\s*\}\)[,;)]/);
  return rest.slice(0, end === -1 ? 400 : end);
}

describe("JetStream resource lists refresh on their own", () => {
  it.each(LIST_QUERIES)("%s: %s has a refetchInterval", (file, ipcCall) => {
    const block = optionsBlockFor(read(file), ipcCall);
    expect(
      block,
      `${file}'s ${ipcCall} query needs refetchInterval — views are kept mounted, ` +
        `so without it this list never refreshes after its first fetch.`,
    ).toContain("refetchInterval");
  });

  it("uses one shared interval rather than scattered magic numbers", () => {
    for (const [file, ipcCall] of LIST_QUERIES) {
      const block = optionsBlockFor(read(file), ipcCall);
      expect(block, `${file}: ${ipcCall}`).toContain("refetchInterval: LIST_REFETCH_MS");
    }
  });

  it("polls often enough to feel live, but not so often it hammers the server", () => {
    expect(LIST_REFETCH_MS).toBeGreaterThanOrEqual(2_000);
    expect(LIST_REFETCH_MS).toBeLessThanOrEqual(30_000);
  });

  it("keeps the global config this fix compensates for", () => {
    // If these ever change, the refetchInterval requirement above may be
    // redundant — this test exists so that tradeoff is made deliberately.
    const main = read("main.tsx");
    expect(main).toContain("retry: false");
    expect(main).toContain("refetchOnWindowFocus: false");
  });
});
