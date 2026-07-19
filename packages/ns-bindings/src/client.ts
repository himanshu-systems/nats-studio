import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppEvent,
  AppInfo,
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionStatusDto,
  ConnectionSummary,
  ConnzDto,
  ConsumerInfoDto,
  CreateConsumerRequest,
  CreateStreamRequest,
  DeleteConsumerRequest,
  DeleteMessageRequest,
  DeleteObjectRequest,
  DeleteStreamRequest,
  FetchMessagesRequest,
  FetchMessagesResponse,
  GetMessagesRequest,
  GetMessagesResponse,
  GetObjectRequest,
  GetObjectResponse,
  GetStreamRequest,
  HealthStatus,
  IpcError,
  KvCreateBucketRequest,
  KvDeleteRequest,
  KvGetRequest,
  KvGetResponse,
  KvPutRequest,
  KvPutResponse,
  ListBucketsRequest,
  ListBucketsResponse,
  ListConnectionsResponse,
  ListConsumersRequest,
  ListConsumersResponse,
  ListKeysRequest,
  ListKeysResponse,
  ListObjectBucketsRequest,
  ListObjectBucketsResponse,
  ListObjectsRequest,
  ListObjectsResponse,
  ListProfilesResponse,
  ListStreamsRequest,
  ListStreamsResponse,
  MessageView,
  MonitorRequest,
  ObjectCreateBucketRequest,
  ObjectInfoDto,
  ObjectProgress,
  ObjectPutRequest,
  ObjectStreamRequest,
  PublishRequest,
  PurgeStreamRequest,
  PurgeStreamResponse,
  RequestRequest,
  Settings,
  StreamInfoDto,
  SubStreamEvent,
  SubscribeRequest,
  SubscriptionHandle,
  VarzDto,
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
    ping: (connectionId: string) => call<number>("connection_ping", { connectionId }),
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
  jetstream: {
    listStreams: (req: ListStreamsRequest) =>
      call<ListStreamsResponse>("js_list_streams", req),
    getStream: (req: GetStreamRequest) => call<StreamInfoDto>("js_get_stream", req),
    createStream: (req: CreateStreamRequest) => call<StreamInfoDto>("js_create_stream", req),
    deleteStream: (req: DeleteStreamRequest) => call<void>("js_delete_stream", req),
    purgeStream: (req: PurgeStreamRequest) =>
      call<PurgeStreamResponse>("js_purge_stream", req),
    listConsumers: (req: ListConsumersRequest) =>
      call<ListConsumersResponse>("js_list_consumers", req),
    createConsumer: (req: CreateConsumerRequest) =>
      call<ConsumerInfoDto>("js_create_consumer", req),
    deleteConsumer: (req: DeleteConsumerRequest) => call<void>("js_delete_consumer", req),
    fetchMessages: (req: FetchMessagesRequest) =>
      call<FetchMessagesResponse>("js_fetch_messages", req),
    listBuckets: (req: ListBucketsRequest) =>
      call<ListBucketsResponse>("js_list_buckets", req),
    listKeys: (req: ListKeysRequest) => call<ListKeysResponse>("js_kv_keys", req),
    kvGet: (req: KvGetRequest) => call<KvGetResponse>("js_kv_get", req),
    kvPut: (req: KvPutRequest) => call<KvPutResponse>("js_kv_put", req),
    kvDelete: (req: KvDeleteRequest) => call<void>("js_kv_delete", req),
    kvCreateBucket: (req: KvCreateBucketRequest) => call<void>("js_kv_create_bucket", req),
    getMessages: (req: GetMessagesRequest) =>
      call<GetMessagesResponse>("js_get_messages", req),
    deleteMessage: (req: DeleteMessageRequest) => call<void>("js_delete_message", req),
    listObjectBuckets: (req: ListObjectBucketsRequest) =>
      call<ListObjectBucketsResponse>("js_list_object_buckets", req),
    listObjects: (req: ListObjectsRequest) =>
      call<ListObjectsResponse>("js_list_objects", req),
    getObject: (req: GetObjectRequest) => call<GetObjectResponse>("js_get_object", req),
    deleteObject: (req: DeleteObjectRequest) => call<void>("js_delete_object", req),
    objectCreateBucket: (req: ObjectCreateBucketRequest) =>
      call<void>("js_object_create_bucket", req),
    objectPut: (req: ObjectPutRequest) => call<ObjectInfoDto>("js_object_put", req),
    /**
     * Stream a local file into an object (no in-memory base64, no size cap).
     * Progress ticks arrive on `onProgress` via a Tauri Channel; resolves with
     * the stored object info.
     */
    objectPutFile: (
      req: ObjectStreamRequest,
      onProgress: (p: ObjectProgress) => void,
    ): Promise<ObjectInfoDto> => {
      const channel = new Channel<ObjectProgress>();
      channel.onmessage = onProgress;
      return invoke<ObjectInfoDto>("js_object_put_file", { req, onProgress: channel }).catch(
        (raw: unknown) => {
          if (isIpcError(raw)) throw new NatsStudioError(raw);
          throw raw;
        },
      );
    },
    /**
     * Stream an object to a local file (uncapped). Progress ticks arrive on
     * `onProgress` via a Tauri Channel.
     */
    objectGetFile: (
      req: ObjectStreamRequest,
      onProgress: (p: ObjectProgress) => void,
    ): Promise<void> => {
      const channel = new Channel<ObjectProgress>();
      channel.onmessage = onProgress;
      return invoke<void>("js_object_get_file", { req, onProgress: channel }).catch(
        (raw: unknown) => {
          if (isIpcError(raw)) throw new NatsStudioError(raw);
          throw raw;
        },
      );
    },
  },
  monitor: {
    varz: (req: MonitorRequest) => call<VarzDto>("monitor_varz", req),
    connz: (req: MonitorRequest) => call<ConnzDto>("monitor_connz", req),
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
