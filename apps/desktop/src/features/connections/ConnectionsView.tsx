import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ConnectionStatus,
  ipc,
  NatsStudioError,
  onAppEvent,
  type ConnectionAuth,
  type ConnectionProfileInput,
  type ConnectionSummary,
} from "@bindings";

const PROFILES_KEY = ["connection", "profiles"] as const;
const CONNECTIONS_KEY = ["connection", "list"] as const;

function errorMessage(e: unknown): string {
  if (e instanceof NatsStudioError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

function statusColor(status: ConnectionStatus): string {
  switch (status) {
    case ConnectionStatus.Connected:
      return "bg-emerald-500";
    case ConnectionStatus.Connecting:
    case ConnectionStatus.Reconnecting:
      return "bg-amber-400 animate-pulse";
    case ConnectionStatus.Failed:
      return "bg-red-500";
    case ConnectionStatus.Disconnected:
      return "bg-slate-400";
  }
}

/** Invalidate the connections list whenever the backend emits any event. */
function useLiveEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const unlisten = onAppEvent(() => {
      void qc.invalidateQueries({ queryKey: CONNECTIONS_KEY });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [qc]);
}

export function ConnectionsView(): JSX.Element {
  useLiveEvents();
  return (
    <div className="grid h-full grid-cols-[minmax(320px,380px)_1fr] divide-x divide-slate-200 dark:divide-slate-800">
      <ProfilesPanel />
      <ConnectionsPanel />
    </div>
  );
}

function ProfilesPanel(): JSX.Element {
  const qc = useQueryClient();
  const profiles = useQuery({
    queryKey: PROFILES_KEY,
    queryFn: () => ipc.connection.listProfiles(),
  });

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
    <section className="flex min-h-0 flex-col">
      <h2 className="px-4 pt-4 text-xs font-semibold uppercase tracking-wide opacity-50">
        Connection profiles
      </h2>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-4">
        {profiles.data?.profiles.length === 0 && (
          <p className="text-xs opacity-50">No profiles yet — create one below.</p>
        )}
        {profiles.data?.profiles.map((p) => (
          <div
            key={p.id}
            className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
          >
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{p.name}</div>
                <div className="truncate text-xs opacity-50">{p.servers.join(", ")}</div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  onClick={() => connect.mutate(p.id)}
                  disabled={connect.isPending}
                  className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  Connect
                </button>
                <button
                  type="button"
                  onClick={() => remove.mutate(p.id)}
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
        {connect.isError && (
          <p className="text-xs text-red-500">{errorMessage(connect.error)}</p>
        )}
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
  const [authKind, setAuthKind] = useState<"none" | "userPassword">("none");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const submit = (): void => {
    const auth: ConnectionAuth =
      authKind === "userPassword"
        ? { kind: "userPassword", data: { username, password } }
        : { kind: "none" };
    props.onCreate({
      name,
      servers: [server],
      auth,
      options: {
        reconnectDelayMs: 2000,
        connectTimeoutMs: 5000,
        pingIntervalMs: 30000,
        noEcho: false,
      },
    });
  };

  const field =
    "w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-2 border-t border-slate-200 p-4 dark:border-slate-800"
    >
      <div className="text-xs font-semibold uppercase tracking-wide opacity-50">New profile</div>
      <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <input
        className={field}
        value={server}
        onChange={(e) => setServer(e.target.value)}
        placeholder="nats://host:4222"
      />
      <select
        className={field}
        value={authKind}
        onChange={(e) => setAuthKind(e.target.value === "userPassword" ? "userPassword" : "none")}
      >
        <option value="none">No auth</option>
        <option value="userPassword">Username / password</option>
      </select>
      {authKind === "userPassword" && (
        <div className="grid grid-cols-2 gap-2">
          <input
            className={field}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
          />
          <input
            className={field}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
          />
        </div>
      )}
      {props.error && <p className="text-xs text-red-500">{props.error}</p>}
      <button
        type="submit"
        disabled={props.pending || name.trim() === "" || server.trim() === ""}
        className="w-full rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
      >
        {props.pending ? "Creating…" : "Create profile"}
      </button>
    </form>
  );
}

function ConnectionsPanel(): JSX.Element {
  const qc = useQueryClient();
  const connections = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: () => ipc.connection.list(),
  });
  const disconnect = useMutation({
    mutationFn: (connectionId: string) => ipc.connection.disconnect(connectionId),
    onSettled: () => qc.invalidateQueries({ queryKey: CONNECTIONS_KEY }),
  });

  const items = connections.data?.connections ?? [];

  return (
    <section className="flex min-h-0 flex-col">
      <h2 className="px-4 pt-4 text-xs font-semibold uppercase tracking-wide opacity-50">
        Connections
      </h2>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-4">
        {items.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm opacity-40">No active connections. Connect a profile to begin.</p>
          </div>
        )}
        {items.map((c) => (
          <ConnectionCard
            key={c.connectionId}
            summary={c}
            onDisconnect={() => disconnect.mutate(c.connectionId)}
          />
        ))}
      </div>
    </section>
  );
}

function ConnectionCard(props: {
  summary: ConnectionSummary;
  onDisconnect: () => void;
}): JSX.Element {
  const { summary } = props;
  const info = summary.serverInfo;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusColor(summary.status)}`} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{summary.name}</div>
            <div className="text-xs capitalize opacity-50">
              {summary.status}
              {summary.rttMs != null && summary.status === ConnectionStatus.Connected
                ? ` · ${summary.rttMs} ms`
                : ""}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={props.onDisconnect}
          className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Disconnect
        </button>
      </div>
      {info && (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-xs dark:border-slate-800">
          <Detail label="Server" value={info.serverName} />
          <Detail label="Version" value={info.version} />
          <Detail label="Max payload" value={`${Math.round(info.maxPayload / 1024)} KiB`} />
          <Detail label="JetStream" value={info.jetstream ? "enabled" : "disabled"} />
        </dl>
      )}
      {summary.lastError && <p className="mt-2 text-xs text-red-500">{summary.lastError}</p>}
    </div>
  );
}

function Detail(props: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex justify-between gap-2">
      <dt className="opacity-50">{props.label}</dt>
      <dd className="truncate font-medium">{props.value}</dd>
    </div>
  );
}
