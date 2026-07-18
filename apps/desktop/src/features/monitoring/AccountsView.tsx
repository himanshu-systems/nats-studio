import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@bindings";
import { Button, EmptyState, Panel, SectionLabel } from "../../components/ui";

const DEFAULT_URL = "http://127.0.0.1:8222";

const fmtNum = (n: number): string => n.toLocaleString();

export function AccountsView(): JSX.Element {
  const [url, setUrl] = useState(DEFAULT_URL);

  const connz = useQuery({
    queryKey: ["monitor", "connz", url],
    queryFn: () => ipc.monitor.connz({ baseUrl: url }),
    refetchInterval: 2000,
  });

  const conns = connz.data?.connections ?? [];

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <SectionLabel>
            Connections {connz.data ? `(${fmtNum(connz.data.numConnections)} of ${fmtNum(connz.data.total)})` : ""}
          </SectionLabel>
          <input
            className="field w-80 font-mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={DEFAULT_URL}
            spellCheck={false}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          icon="replay"
          onClick={() => void connz.refetch()}
          disabled={connz.isFetching}
        >
          {connz.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {connz.isError ? (
        <EmptyState icon="alert" title="Cannot reach monitoring endpoint">
          Could not read <span className="font-mono">{url}/connz</span>. Ensure the NATS server was
          started with HTTP monitoring enabled (<span className="font-mono">-m 8222</span>).
        </EmptyState>
      ) : conns.length === 0 && !connz.isLoading ? (
        <EmptyState icon="users" title="No client connections">
          The server reports no active client connections right now.
        </EmptyState>
      ) : (
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted">
                <Th>CID</Th>
                <Th>Name</Th>
                <Th>Address</Th>
                <Th className="text-right">Subs</Th>
                <Th className="text-right">Msgs in</Th>
                <Th className="text-right">Msgs out</Th>
                <Th>Lang</Th>
                <Th className="text-right">Uptime</Th>
              </tr>
            </thead>
            <tbody>
              {conns.map((c) => (
                <tr key={c.cid} className="border-b border-border/50 last:border-0">
                  <Td className="font-mono tabular-nums">{c.cid}</Td>
                  <Td className="max-w-[160px] truncate text-content">{c.name || "—"}</Td>
                  <Td className="font-mono text-muted">{`${c.ip}:${c.port}`}</Td>
                  <Td className="text-right tabular-nums">{fmtNum(c.subscriptions)}</Td>
                  <Td className="text-right tabular-nums">{fmtNum(c.inMsgs)}</Td>
                  <Td className="text-right tabular-nums">{fmtNum(c.outMsgs)}</Td>
                  <Td className="text-muted">
                    {c.lang ? `${c.lang}${c.version ? ` ${c.version}` : ""}` : "—"}
                  </Td>
                  <Td className="text-right text-muted">{c.uptime || "—"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }): JSX.Element {
  return <th className={`px-3 py-2 font-semibold ${className ?? ""}`}>{children}</th>;
}

function Td({ children, className }: { children: React.ReactNode; className?: string }): JSX.Element {
  return <td className={`px-3 py-2 ${className ?? ""}`}>{children}</td>;
}
