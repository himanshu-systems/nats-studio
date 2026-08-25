import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Behavioural counterpart to `listRefresh.test.ts`: that file asserts the
 * option is present, this one proves the option does what the fix needs it to
 * — refetch a component that stays mounted forever, under the app's real
 * global query config (`retry: false`, `refetchOnWindowFocus: false`).
 */
function makeClient(): QueryClient {
  return new QueryClient({
    // mirrors main.tsx, so this exercises the app's real query behaviour
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
}

function Streams({ fetcher, interval }: { fetcher: () => Promise<string[]>; interval?: number }) {
  const q = useQuery({
    queryKey: ["streams"],
    queryFn: fetcher,
    refetchInterval: interval,
  });
  return <div data-testid="out">{(q.data ?? []).join(",") || (q.isError ? "error" : "empty")}</div>;
}

function renderStreams(fetcher: () => Promise<string[]>, interval?: number) {
  return render(
    <QueryClientProvider client={makeClient()}>
      <Streams fetcher={fetcher} interval={interval} />
    </QueryClientProvider>,
  );
}

describe("a kept-mounted list view", () => {
  it("never refetches on its own without refetchInterval — the original bug", async () => {
    const fetcher = vi.fn(async () => [] as string[]);
    renderStreams(fetcher); // no interval
    await waitFor(() => expect(screen.getByTestId("out")).toHaveTextContent("empty"));

    // The component stays mounted; nothing triggers another fetch.
    await new Promise((r) => setTimeout(r, 250));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("picks up resources created after its first fetch, with refetchInterval", async () => {
    let streams: string[] = [];
    const fetcher = vi.fn(async () => streams);
    renderStreams(fetcher, 50);

    await waitFor(() => expect(screen.getByTestId("out")).toHaveTextContent("empty"));

    // A stream is created elsewhere after the view already loaded once.
    streams = ["ORDERS"];
    await waitFor(() => expect(screen.getByTestId("out")).toHaveTextContent("ORDERS"), {
      timeout: 2000,
    });
  });

  it("recovers from a transient error even though retry is disabled", async () => {
    let failing = true;
    const fetcher = vi.fn(async () => {
      if (failing) throw new Error("JetStream not ready");
      return ["ORDERS"];
    });
    renderStreams(fetcher, 50);

    // retry:false means the first failure surfaces immediately and sticks...
    await waitFor(() => expect(screen.getByTestId("out")).toHaveTextContent("error"));

    // ...until the next poll, which is what makes the failure self-healing.
    failing = false;
    await waitFor(() => expect(screen.getByTestId("out")).toHaveTextContent("ORDERS"), {
      timeout: 2000,
    });
  });
});
