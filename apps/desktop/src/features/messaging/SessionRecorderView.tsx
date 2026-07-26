import { useEffect, useMemo, useRef, useState } from "react";
import { ipc, PayloadEncoding, type MessageView } from "@bindings";
import { RequireConnection } from "../../components/RequireConnection";
import { Button, Badge, EmptyState, cx } from "../../components/ui";
import { Select } from "../../components/Select";
import { ErrorNote } from "../../components/ErrorNote";
import { useConfirm } from "../../components/ConfirmDialog";
import { errorMessage, fmtBytes, FlashBadge, MessageMeta, PayloadView, useFlash } from "./message";

/** One recorded message: the decoded view plus its arrival offset (ms) from
 *  the moment recording started. Exactly what gets written to / read from disk. */
interface SessionMessage {
  message: MessageView;
  receivedAtMs: number;
}

/** A saved/loaded session file. */
interface RecordedSession {
  subject: string;
  createdAt: string;
  messages: SessionMessage[];
}

type Speed = 1 | 2 | 5 | "instant";
const SPEED_OPTIONS = [
  { value: "1", label: "1x" },
  { value: "2", label: "2x" },
  { value: "5", label: "5x" },
  { value: "instant", label: "Instant" },
];

function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "session";
}

/** JSON -> Blob download via a synthetic anchor (same pattern as the Object
 *  Store's base64 download, just with a JSON string instead of raw bytes). */
function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function SessionRecorderView(): JSX.Element {
  return <RequireConnection>{(connId) => <SessionRecorder connId={connId} />}</RequireConnection>;
}

function SessionRecorder({ connId }: { connId: string }): JSX.Element {
  const confirm = useConfirm();

  // --- recording -----------------------------------------------------------
  const [subject, setSubject] = useState("events.>");
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  // Stop and Start-recording swap in the same toolbar slot, so a reflexive
  // second click right after Stop can land on the fresh Start button and
  // immediately re-open the "unsaved session" prompt. Briefly disable it so
  // that click has nowhere to land.
  // ponytail: fixed cooldown window, not real click-intent detection — bump
  // the delay if reports of this keep coming in.
  const [justStopped, setJustStopped] = useState(false);
  const [subId, setSubId] = useState<string | null>(null);
  const [buffer, setBuffer] = useState<SessionMessage[]>([]);
  const [recordError, setRecordError] = useState<string | null>(null);
  const startRef = useRef(0);
  const subIdRef = useRef<string | null>(null);
  subIdRef.current = subId;

  // Tear down a live subscription if the view unmounts mid-recording.
  useEffect(() => () => { if (subIdRef.current) void ipc.pubsub.unsubscribe(subIdRef.current); }, []);

  // --- the session available for saving / replay ----------------------------
  const [session, setSession] = useState<RecordedSession | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [saved, flashSaved] = useFlash();

  const startRecording = async (): Promise<void> => {
    const subj = subject.trim();
    if (subj === "" || recording || starting) return;
    setStarting(true);
    try {
      if (dirty) {
        const ok = await confirm({
          title: "Start a new recording?",
          description: `The current session isn't saved yet — ${session?.messages.length ?? 0} message(s) will be lost.`,
          consequences: ["The unsaved session will be discarded."],
          confirmLabel: "Start recording",
          confirmIcon: "signal",
        });
        if (!ok) return;
      }
      setRecordError(null);
      setBuffer([]);
      setSession(null);
      setDirty(false);
      startRef.current = Date.now();
      const handle = await ipc.pubsub.subscribe({ connectionId: connId, subject: subj }, (event) => {
        if (event.kind === "message") {
          setBuffer((prev) => [...prev, { message: event.data, receivedAtMs: Date.now() - startRef.current }]);
        } else if (event.kind === "error") {
          setRecordError(`${event.data.code}: ${event.data.message}`);
        }
      });
      setSubId(handle.subscriptionId);
      setRecording(true);
    } catch (e) {
      setRecordError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const stopRecording = (): void => {
    if (subId) void ipc.pubsub.unsubscribe(subId);
    setSubId(null);
    setRecording(false);
    setSession({ subject: subject.trim(), createdAt: new Date().toISOString(), messages: buffer });
    setDirty(buffer.length > 0);
    setJustStopped(true);
    window.setTimeout(() => setJustStopped(false), 600);
  };

  const saveSession = (): void => {
    if (!session) return;
    const name = `session-${sanitizeForFilename(session.subject)}-${Date.now()}.json`;
    downloadJson(name, session);
    flashSaved(`Downloaded ${name}`);
    setDirty(false);
  };

  const loadSession = async (file: File): Promise<void> => {
    if (dirty) {
      const ok = await confirm({
        title: "Load a different session?",
        description: `The current session isn't saved yet — ${session?.messages.length ?? 0} message(s) will be lost.`,
        consequences: ["The unsaved session will be discarded."],
        confirmLabel: "Load session",
        confirmIcon: "inbox",
      });
      if (!ok) return;
    }
    setLoadError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as Partial<RecordedSession>;
        if (!Array.isArray(parsed.messages)) throw new Error('Not a session file — missing a "messages" array.');
        setSession({
          subject: typeof parsed.subject === "string" ? parsed.subject : "",
          createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
          messages: parsed.messages as SessionMessage[],
        });
        setDirty(false);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    };
    reader.onerror = () => setLoadError("Failed to read the file.");
    reader.readAsText(file);
  };

  // --- replay ---------------------------------------------------------------
  const [filterText, setFilterText] = useState("");
  const [filterExact, setFilterExact] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [replayError, setReplayError] = useState<unknown>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const genRef = useRef(0);

  const filtered = useMemo((): SessionMessage[] => {
    const messages = session?.messages ?? (recording ? buffer : []);
    const needle = filterText.trim();
    if (needle === "") return messages;
    return messages.filter((m) =>
      filterExact ? m.message.subject === needle : m.message.subject.includes(needle),
    );
  }, [session, recording, buffer, filterText, filterExact]);

  const pause = (): void => {
    cancelRef.current?.();
    cancelRef.current = null;
    genRef.current += 1;
    setPlaying(false);
  };

  const seekTo = (i: number): void => {
    pause();
    setIdx(i);
  };

  // Reset the playhead whenever the session or the filter changes underneath it.
  useEffect(() => {
    seekTo(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, filterText, filterExact]);

  // Stop any in-flight playback timer if the view unmounts.
  useEffect(() => () => cancelRef.current?.(), []);

  const sleep = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const id = window.setTimeout(() => resolve(true), ms);
      cancelRef.current = () => {
        window.clearTimeout(id);
        resolve(false);
      };
    });

  const publishOne = (m: MessageView): void => {
    void ipc.pubsub
      .publish({
        connectionId: connId,
        subject: m.subject,
        payload: m.payloadBase64,
        encoding: PayloadEncoding.Base64,
        headers: m.headers,
        reply: m.reply,
      })
      .catch((e: unknown) => setReplayError(e));
  };

  const runPlayback = async (startIdx: number): Promise<void> => {
    const list = filtered;
    if (list.length === 0) return;
    const gen = ++genRef.current;
    setReplayError(null);
    setPlaying(true);
    let i = startIdx;
    while (i < list.length) {
      if (genRef.current !== gen) return;
      const cur = list[i]!;
      setIdx(i);
      publishOne(cur.message);
      const next = list[i + 1];
      if (!next) break;
      if (speed !== "instant") {
        const delayMs = Math.max(0, (next.receivedAtMs - cur.receivedAtMs) / speed);
        const completed = await sleep(delayMs);
        if (!completed || genRef.current !== gen) return;
      }
      i += 1;
    }
    if (genRef.current === gen) setPlaying(false);
  };

  const play = async (): Promise<void> => {
    if (filtered.length === 0 || playing) return;
    const ok = await confirm({
      title: "Replay this session?",
      description: `${filtered.length} message(s) will be republished to the connected server${speed === "instant" ? ", instantly" : ` at ${speed}x speed`}.`,
      consequences: ["Anything subscribed to these subjects right now will receive them again."],
      confirmLabel: "Replay",
      confirmIcon: "replay",
      danger: false,
    });
    if (!ok) return;
    const start = idx >= filtered.length - 1 ? 0 : idx;
    void runPlayback(start);
  };

  const current = filtered[Math.min(idx, Math.max(filtered.length - 1, 0))] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void startRecording();
        }}
        className="space-y-2 border-b border-border bg-surface px-4 py-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="field max-w-[260px]"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="events.>"
            disabled={recording}
          />
          {!recording ? (
            <Button type="submit" icon="signal" disabled={subject.trim() === "" || starting || justStopped}>
              {starting ? "Starting…" : "Start recording"}
            </Button>
          ) : (
            <Button type="button" variant="danger" icon="x" onClick={stopRecording}>
              Stop
            </Button>
          )}
          {recording && <Badge tone="positive">{buffer.length} captured</Badge>}
          {session && !recording && (
            <>
              <Badge tone={dirty ? "warning" : "neutral"}>
                {session.messages.length} message(s){dirty ? " — unsaved" : ""}
              </Badge>
              <Button type="button" size="sm" variant="outline" icon="archive" onClick={saveSession}>
                Save session
              </Button>
              <FlashBadge message={saved} />
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadSession(f);
              e.target.value = "";
            }}
          />
          <Button type="button" size="sm" variant="outline" icon="inbox" onClick={() => fileRef.current?.click()}>
            Load session
          </Button>
        </div>
        {recordError && <p className="text-xs text-danger">{recordError}</p>}
        {loadError && <p className="text-xs text-danger">{loadError}</p>}
      </form>

      {session === null && !recording ? (
        <EmptyState icon="replay" title="No session loaded">
          Record live messages above, or load a previously saved session to replay it.
        </EmptyState>
      ) : (
        <>
          <div className="space-y-2 border-b border-border px-4 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="field max-w-[220px]"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="Filter by subject…"
              />
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={filterExact} onChange={(e) => setFilterExact(e.target.checked)} />
                Exact match
              </label>
              <Select
                className="w-28"
                searchable={false}
                value={String(speed)}
                onChange={(v) => setSpeed(v === "instant" ? "instant" : (Number(v) as Speed))}
                options={SPEED_OPTIONS}
              />
              {!playing ? (
                <Button
                  size="sm"
                  icon="signal"
                  onClick={() => void play()}
                  disabled={filtered.length === 0 || recording}
                >
                  Play
                </Button>
              ) : (
                <Button size="sm" variant="outline" icon="clock" onClick={pause}>
                  Pause
                </Button>
              )}
              <Badge tone="neutral">
                {Math.min(idx + 1, filtered.length)} / {filtered.length}
              </Badge>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0, filtered.length - 1)}
              value={Math.min(idx, Math.max(0, filtered.length - 1))}
              onChange={(e) => seekTo(Number(e.target.value))}
              disabled={filtered.length === 0}
              className="w-full accent-accent"
            />
            {replayError !== null && <ErrorNote error={replayError} />}
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] divide-x divide-border overflow-hidden">
            <ul className="min-h-0 overflow-auto">
              {filtered.length === 0 && (
                <li className="p-4 text-xs text-muted">
                  {recording
                    ? "Waiting for messages on this subject…"
                    : session && session.messages.length === 0
                      ? "No messages were captured during this recording — nothing was published to this subject while it ran."
                      : "No messages match this filter."}
                </li>
              )}
              {filtered.map((m, i) => (
                <li key={`${m.message.subject}-${m.receivedAtMs}-${i}`}>
                  <button
                    type="button"
                    onClick={() => seekTo(i)}
                    className={cx(
                      "block w-full border-b border-border/60 px-4 py-2 text-left transition-colors hover:bg-surface-2",
                      i === idx && "bg-surface-2",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-content">{m.message.subject}</span>
                      <span className="flex shrink-0 items-center gap-2 text-[10px] text-faint">
                        <span className="tabular-nums">+{(m.receivedAtMs / 1000).toFixed(2)}s</span>
                        <span className="tabular-nums">{fmtBytes(m.message.size)}</span>
                      </span>
                    </div>
                    <div className="truncate font-mono text-xs text-muted">{m.message.preview.slice(0, 100)}</div>
                  </button>
                </li>
              ))}
            </ul>

            <div className="min-h-0 overflow-auto p-4">
              {current ? (
                <div className="space-y-2">
                  <MessageMeta view={current.message} />
                  <PayloadView view={current.message} />
                </div>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <p className="text-sm text-muted">Select a message to inspect its payload and headers.</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
