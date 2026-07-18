import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ConnectionStatus,
  ipc,
  type ConnectionAuth,
  type ConnectionProfileInput,
  type ConnectionSummary,
} from "@bindings";
import { CONNECTIONS_KEY, PROFILES_KEY } from "../../lib/liveEvents";
import { useActiveConnection } from "../../lib/activeConnection";
import { Badge, Button, EmptyState, Panel, SectionLabel, StatusDot, statusMeta, cx } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { errorMessage } from "../messaging/message";

type AuthKind = "none" | "userPassword" | "token";

/** Global connection management: profiles (left) and live connections (right). */
export function ConnectionsView(): JSX.Element {
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(340px,400px)_1fr] divide-x divide-border">
      <ProfilesPanel />
      <ConnectionsPanel />
    </div>
  );
}

function ProfilesPanel(): JSX.Element {
  const qc = useQueryClient();
  const profiles = useQuery({ queryKey: PROFILES_KEY, queryFn: () => ipc.connection.listProfiles() });

  const create = useMutation({
    mutationFn: (input: ConnectionProfileInput) => ipc.connection.createProfile(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: PROFILES_KEY }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => ipc.connection.deleteProfile(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: PROFILES_KEY }),
  });
  const connect = useMutation({
    mutationFn: (profileId: string) => ipc.connection.connect(profileId),
    onSettled: () => qc.invalidateQueries({ queryKey: CONNECTIONS_KEY }),
  });

  return (
    <section className="flex min-h-0 flex-col bg-surface">
      <div className="px-4 pt-4">
        <SectionLabel>Connection profiles</SectionLabel>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-4">
        {profiles.data?.profiles.length === 0 && (
          <p className="text-xs text-muted">No profiles yet — create one below.</p>
        )}
        {profiles.data?.profiles.map((p) => (
          <Panel key={p.id} className="p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-content">{p.name}</div>
                <div className="truncate font-mono text-xs text-muted">{p.servers.join(", ")}</div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button size="sm" icon="link" onClick={() => connect.mutate(p.id)} disabled={connect.isPending}>
                  Connect
                </Button>
                <Button size="sm" variant="ghost" icon="trash" onClick={() => remove.mutate(p.id)} aria-label="Delete profile" />
              </div>
            </div>
          </Panel>
        ))}
        {connect.isError && <p className="text-xs text-danger">{errorMessage(connect.error)}</p>}
      </div>
      <CreateProfileForm
        pending={create.isPending}
        error={create.isError ? errorMessage(create.error) : null}
        onCreate={(input) => create.mutate(input)}
      />
    </section>
  );
}

function CreateProfileForm(props: {
  pending: boolean;
  error: string | null;
  onCreate: (input: ConnectionProfileInput) => void;
}): JSX.Element {
  const [name, setName] = useState("Local");
  const [server, setServer] = useState("nats://127.0.0.1:4222");
  const [authKind, setAuthKind] = useState<AuthKind>("none");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");

  const buildAuth = (): ConnectionAuth => {
    if (authKind === "userPassword") return { kind: "userPassword", data: { username, password } };
    if (authKind === "token") return { kind: "token", data: { token } };
    return { kind: "none" };
  };

  const submit = (): void => {
    props.onCreate({
      name,
      servers: [server],
      auth: buildAuth(),
      options: { reconnectDelayMs: 2000, connectTimeoutMs: 5000, pingIntervalMs: 30000, noEcho: false },
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-2 border-t border-border p-4"
    >
      <SectionLabel>New profile</SectionLabel>
      <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <input className="field font-mono" value={server} onChange={(e) => setServer(e.target.value)} placeholder="nats://host:4222" />
      <select className="field" value={authKind} onChange={(e) => setAuthKind(e.target.value as AuthKind)}>
        <option value="none">No auth</option>
        <option value="userPassword">Username / password</option>
        <option value="token">Token</option>
      </select>
      {authKind === "userPassword" && (
        <div className="grid grid-cols-2 gap-2">
          <input className="field" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
          <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
        </div>
      )}
      {authKind === "token" && (
        <input className="field" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Token" />
      )}
      {props.error && <p className="text-xs text-danger">{props.error}</p>}
      <Button type="submit" className="w-full" icon="plus" disabled={props.pending || name.trim() === "" || server.trim() === ""}>
        {props.pending ? "Creating…" : "Create profile"}
      </Button>
    </form>
  );
}

function ConnectionsPanel(): JSX.Element {
  const qc = useQueryClient();
  const { activeId, setActiveId } = useActiveConnection();
  const connections = useQuery({ queryKey: CONNECTIONS_KEY, queryFn: () => ipc.connection.list() });
  const disconnect = useMutation({
    mutationFn: (connectionId: string) => ipc.connection.disconnect(connectionId),
    onSettled: () => qc.invalidateQueries({ queryKey: CONNECTIONS_KEY }),
  });

  const items = connections.data?.connections ?? [];

  return (
    <section className="flex min-h-0 flex-col">
      <div className="px-4 pt-4">
        <SectionLabel>Active connections</SectionLabel>
      </div>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-auto p-4">
        {items.length === 0 ? (
          <EmptyState icon="link" title="No active connections">
            Connect a profile from the left to open a live connection.
          </EmptyState>
        ) : (
          items.map((c) => (
            <ConnectionCard
              key={c.connectionId}
              summary={c}
              active={c.connectionId === activeId}
              onSelect={() => setActiveId(c.connectionId)}
              onDisconnect={() => disconnect.mutate(c.connectionId)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function ConnectionCard(props: {
  summary: ConnectionSummary;
  active: boolean;
  onSelect: () => void;
  onDisconnect: () => void;
}): JSX.Element {
  const { summary, active } = props;
  const info = summary.serverInfo;
  const meta = statusMeta(summary.status);
  const connected = summary.status === ConnectionStatus.Connected;

  return (
    <Panel className={cx("p-4 transition-shadow", active && "ring-2 ring-accent/40")}>
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={props.onSelect} className="flex min-w-0 items-center gap-2.5 text-left">
          <StatusDot status={summary.status} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-content">{summary.name}</span>
              {active && <Badge tone="accent">Active</Badge>}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <Badge tone={meta.tone}>{meta.label}</Badge>
              {connected && summary.rttMs != null && <span>· {summary.rttMs} ms</span>}
            </div>
          </div>
        </button>
        <div className="flex shrink-0 gap-1.5">
          {!active && connected && (
            <Button size="sm" variant="outline" onClick={props.onSelect}>
              Use
            </Button>
          )}
          <Button size="sm" variant="outline" icon="x" onClick={props.onDisconnect}>
            Disconnect
          </Button>
        </div>
      </div>
      {info && (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 border-t border-border/60 pt-3 text-xs">
          <Detail label="Server" value={info.serverName} />
          <Detail label="Version" value={info.version} />
          <Detail label="Max payload" value={`${Math.round(info.maxPayload / 1024)} KiB`} />
          <Detail label="JetStream">
            <Icon name={info.jetstream ? "check" : "x"} size={13} className={info.jetstream ? "text-positive" : "text-faint"} />
            {info.jetstream ? "Enabled" : "Disabled"}
          </Detail>
        </dl>
      )}
      {summary.lastError && <p className="mt-2 text-xs text-danger">{summary.lastError}</p>}
    </Panel>
  );
}

function Detail({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="flex items-center gap-1 truncate font-medium text-content">{children ?? value}</dd>
    </div>
  );
}
