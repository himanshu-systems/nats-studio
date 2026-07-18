import { useMemo, useState } from "react";
import type { MessageView, MessageHeader } from "@bindings";
import { NatsStudioError } from "@bindings";
import { Badge, cx } from "../../components/ui";
import { Icon } from "../../components/Icon";

export function errorMessage(e: unknown): string {
  if (e instanceof NatsStudioError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** Parse a `Key: Value` per-line textarea into wire headers, skipping blanks. */
export function parseHeaders(raw: string): MessageHeader[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes(":"))
    .map((line) => {
      const idx = line.indexOf(":");
      return { name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
    })
    .filter((h) => h.name.length > 0);
}

const FORMAT_TONE: Record<string, "accent" | "positive" | "neutral" | "warning"> = {
  json: "accent",
  text: "positive",
  binary: "warning",
  empty: "neutral",
};

/** Compact one-line metadata row for a decoded message. */
export function MessageMeta({ view }: { view: MessageView }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      <span className="font-medium text-content">{view.subject}</span>
      <Badge tone={FORMAT_TONE[view.format] ?? "neutral"}>{view.format}</Badge>
      <span className="tabular-nums">{view.size} B</span>
      {view.compression !== "none" && <Badge tone="warning">{view.compression}</Badge>}
      {view.reply && <span className="truncate">reply → {view.reply}</span>}
      <span className="text-faint">{new Date(view.ts).toLocaleTimeString()}</span>
    </div>
  );
}

// --- payload decoding --------------------------------------------------------

const MAX_RENDER = 64 * 1024;
type Mode = "json" | "text" | "hex" | "proto" | "base64";

function b64ToBytes(b64: string): Uint8Array {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  } catch {
    return new Uint8Array();
  }
}

const utf8 = (b: Uint8Array): string => new TextDecoder("utf-8", { fatal: false }).decode(b);

function prettyJson(bytes: Uint8Array): string | null {
  try {
    return JSON.stringify(JSON.parse(utf8(bytes)), null, 2);
  } catch {
    return null;
  }
}

function hexdump(bytes: Uint8Array): string {
  const lines: string[] = [];
  const n = Math.min(bytes.length, MAX_RENDER);
  for (let o = 0; o < n; o += 16) {
    const chunk = bytes.subarray(o, Math.min(o + 16, n));
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${o.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (bytes.length > n) lines.push(`… ${(bytes.length - n).toLocaleString()} more bytes`);
  return lines.join("\n");
}

function readVarint(bytes: Uint8Array, start: number): [bigint, number] | null {
  let shift = 0n;
  let result = 0n;
  let i = start;
  while (i < bytes.length) {
    const b = bytes[i++]!;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, i];
    shift += 7n;
    if (shift > 70n) return null;
  }
  return null;
}

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Schema-less protobuf wire-format decode: field number, wire type, raw value. */
function decodeProto(bytes: Uint8Array): string | null {
  const out: string[] = [];
  let i = 0;
  let guard = 0;
  while (i < bytes.length && guard++ < 20000) {
    const tag = readVarint(bytes, i);
    if (!tag) return null;
    const [t, ni] = tag;
    i = ni;
    const field = Number(t >> 3n);
    const wire = Number(t & 7n);
    if (field === 0) return null;
    if (wire === 0) {
      const v = readVarint(bytes, i);
      if (!v) return null;
      i = v[1];
      out.push(`${field}: varint  ${v[0].toString()}`);
    } else if (wire === 1) {
      if (i + 8 > bytes.length) return null;
      const s = bytes.subarray(i, i + 8);
      i += 8;
      out.push(`${field}: fixed64 0x${toHex(s.slice().reverse())}`);
    } else if (wire === 2) {
      const l = readVarint(bytes, i);
      if (!l) return null;
      i = l[1];
      const len = Number(l[0]);
      if (i + len > bytes.length) return null;
      const s = bytes.subarray(i, i + len);
      i += len;
      const text = utf8(s);
      const printable = /^[\t\n\r\x20-\x7e]*$/.test(text);
      out.push(`${field}: len=${len}  ${printable ? JSON.stringify(text) : `0x${toHex(s.subarray(0, 32))}${len > 32 ? "…" : ""}`}`);
    } else if (wire === 5) {
      if (i + 4 > bytes.length) return null;
      const s = bytes.subarray(i, i + 4);
      i += 4;
      out.push(`${field}: fixed32 0x${toHex(s.slice().reverse())}`);
    } else {
      return null; // groups / invalid wire types
    }
  }
  return out.length ? out.join("\n") : null;
}

/** Payload viewer: format tabs (JSON / Text / Hex / Protobuf / Base64) + copy. */
export function PayloadView({ view, className }: { view: MessageView; className?: string }): JSX.Element {
  const bytes = useMemo(() => b64ToBytes(view.payloadBase64), [view.payloadBase64]);
  const compressed = view.compression !== "none";
  const [copied, setCopied] = useState(false);

  const defaultMode: Mode = view.format === "json" ? "json" : view.format === "binary" ? "hex" : "text";
  const [mode, setMode] = useState<Mode>(defaultMode);

  const rendered = useMemo((): string => {
    if (bytes.length === 0) return "";
    // Compressed payloads: the backend already decompressed into `preview`.
    if (compressed && (mode === "json" || mode === "text")) return view.preview;
    switch (mode) {
      case "json":
        return prettyJson(bytes) ?? "(not valid JSON)\n\n" + utf8(bytes.subarray(0, MAX_RENDER));
      case "text":
        return utf8(bytes.subarray(0, MAX_RENDER)) + (bytes.length > MAX_RENDER ? "\n… truncated" : "");
      case "hex":
        return hexdump(bytes);
      case "proto":
        return decodeProto(bytes) ?? "(not a valid protobuf wire-format message)";
      case "base64":
        return view.payloadBase64;
    }
  }, [bytes, mode, compressed, view.preview, view.payloadBase64]);

  const copy = (): void => {
    void navigator.clipboard.writeText(rendered).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  const modes: Mode[] = ["json", "text", "hex", "proto", "base64"];

  return (
    <div className={cx("space-y-2", className)}>
      {view.headers.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg border border-border bg-surface-2 p-2 text-xs">
          {view.headers.map((h, i) => (
            <div key={i} className="contents">
              <dt className="font-mono text-muted">{h.name}</dt>
              <dd className="truncate font-mono text-content">{h.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cx(
                "rounded-md px-2 py-1 text-[11px] font-medium capitalize transition-colors",
                mode === m ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-2 hover:text-content",
              )}
            >
              {m === "proto" ? "Protobuf" : m === "base64" ? "Base64" : m}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-1 text-[11px] text-muted transition-colors hover:text-content"
        >
          <Icon name={copied ? "check" : "copy"} size={13} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <pre className="max-h-[60vh] overflow-auto whitespace-pre rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed text-content">
        {bytes.length === 0 ? <span className="text-faint">(empty payload)</span> : rendered}
      </pre>
    </div>
  );
}
