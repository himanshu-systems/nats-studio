import { invoke, Channel } from "@tauri-apps/api/core";
import type { AppInfo, IpcError } from "./generated/types";

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

/** Typed command facade, namespaced by subsystem (grows as commands land). */
export const ipc = {
  app: {
    info: () => call<AppInfo>("app_info"),
  },
};

export { Channel };
