import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppEvent,
  AppInfo,
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionStatusDto,
  ConnectionSummary,
  HealthStatus,
  IpcError,
  ListConnectionsResponse,
  ListProfilesResponse,
  MessageView,
  PublishRequest,
  RequestRequest,
  Settings,
  SubStreamEvent,
  SubscribeRequest,
  SubscriptionHandle,
} from "./generated/types";

/**
 * Frontend rehydration of the backend's `IpcError` wire DTO. TanStack Query and
 * UI code branch on `code`/`retriable`. See spine section 7.5.
 */
export class NatsStudioError extends Error {
  readonly code: IpcError["code"];
  readonly retriable: boolean;
  readonly correlationId?: string;
  readonly causes: string[];

  constructor(err: IpcError) {
    super(err.message);
    this.name = "NatsStudioError";
    this.code = err.code;
    this.retriable = err.retriable;
    this.correlationId = err.correlationId;
    this.causes = err.causes;
  }
}

function isIpcError(value: unknown): value is IpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    "retriable" in value
  );
}

/**
 * The single choke point for every Tauri command. Commands take one argument
 * named `req` and reject with an `IpcError`, which we normalize to a typed
 * `NatsStudioError`. Feature code must call through the `ipc` facade below,
 * never `invoke` with a string literal.
 */
export async function call<T>(command: string, req?: unknown): Promise<T> {
  try {
    return await invoke<T>(command, req === undefined ? undefined : { req });
  } catch (raw) {
    if (isIpcError(raw)) {
      throw new NatsStudioError(raw);
    }
    throw raw;
  }
}

/** Typed command facade, namespaced by subsystem. */
export const ipc = {
  app: {
    info: () => call<AppInfo>("app_info"),
    health: () => call<HealthStatus>("app_health"),
  },
  settings: {
    get: () => call<Settings>("settings_get"),
    update: (settings: Settings) => call<void>("settings_update", { settings }),
  },
  connection: {
    listProfiles: () => call<ListProfilesResponse>("connection_list_profiles"),
    createProfile: (profile: ConnectionProfileInput) =>
      call<ConnectionProfile>("connection_create_profile", { profile }),
    updateProfile: (profile: ConnectionProfile) =>
      call<ConnectionProfile>("connection_update_profile", { profile }),
    deleteProfile: (id: string) => call<void>("connection_delete_profile", { id }),
    connect: (profileId: string) => call<ConnectionSummary>("connection_connect", { profileId }),
    disconnect: (connectionId: string) => call<void>("connection_disconnect", { connectionId }),
    list: () => call<ListConnectionsResponse>("connection_list"),
    getStatus: (connectionId: string) =>
      call<ConnectionStatusDto | null>("connection_get_status", { connectionId }),
  },
  pubsub: {
    publish: (req: PublishRequest) => call<void>("pubsub_publish", req),
    request: (req: RequestRequest) => call<MessageView>("pubsub_request", req),
    /**
     * Open a streaming subscription. Each decoded message (and a terminal
     * `error`/`ended`) arrives on `onEvent` via a Tauri Channel. Resolves with a
     * `SubscriptionHandle` — pass its id to `unsubscribe` to stop the stream.
     */
    subscribe: (
      req: SubscribeRequest,
      onEvent: (event: SubStreamEvent) => void,
    ): Promise<SubscriptionHandle> => {
      const channel = new Channel<SubStreamEvent>();
      channel.onmessage = onEvent;
      return invoke<SubscriptionHandle>("pubsub_subscribe", { req, onEvent: channel }).catch(
        (raw: unknown) => {
          if (isIpcError(raw)) throw new NatsStudioError(raw);
          throw raw;
        },
      );
    },
    unsubscribe: (subscriptionId: string) =>
      call<void>("pubsub_unsubscribe", { subscriptionId }),
  },
};

/**
 * Subscribe to the single ambient event channel bridged from the Rust event bus
 * (`ns://event`). Returns an unlisten function. Each `AppEvent` carries its own
 * `topic`; consumers switch on `payload`.
 */
export function onAppEvent(handler: (event: AppEvent) => void): Promise<UnlistenFn> {
  return listen<AppEvent>("ns://event", (msg) => handler(msg.payload));
}

export { Channel };
