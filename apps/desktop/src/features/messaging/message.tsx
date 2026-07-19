import { useMemo, useState } from "react";
import type { MessageView, MessageHeader } from "@bindings";
import { NatsStudioError } from "@bindings";
import { Badge, cx } from "../../components/ui";
import { Icon } from "../../components/Icon";

export function errorMessage(e: unknown): string {
  if (e instanceof NatsStudioError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** Format a byte count with binary units (B / KiB / MiB / …). */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${u[i]}`;
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
      <span className="tabular-nums">{fmtBytes(view.size)}</span>
      {view.compression !== "none" && <Badge tone="warning">{view.compression}</Badge>}
      {view.reply && <span className="truncate">reply → {view.reply}</span>}
      <span className="text-faint">{new Date(view.ts).toLocaleTimeString()}</span>
    </div>
  );
}

// --- payload decoding --------------------------------------------------------

const MAX_RENDER = 64 * 1024;
type Mode = "json" | "text" | "hex" | "proto" | "msgpack" | "base64";

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

/** Minimal MessagePack decoder (common subset). Returns the decoded value, or
 *  throws if the bytes aren't valid / fully-consumed MessagePack. */
function decodeMsgpack(bytes: Uint8Array): unknown {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const big = (v: bigint): number | string =>
    v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  const str = (len: number): string => {
    const s = utf8(bytes.subarray(pos, pos + len));
    pos += len;
    return s;
  };
  const bin = (len: number): string => {
    const s = bytes.subarray(pos, pos + len);
    pos += len;
    return `<bin ${len}B 0x${toHex(s.subarray(0, 16))}${len > 16 ? "…" : ""}>`;
  };
  const arr = (n: number): unknown[] => {
    const a: unknown[] = [];
    for (let i = 0; i < n; i++) a.push(read());
    return a;
  };
  const map = (n: number): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) {
      const k = read();
      o[String(k)] = read();
    }
    return o;
  };
  function read(): unknown {
    const b = dv.getUint8(pos++);
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 256;
    if (b <= 0x8f) return map(b & 0x0f);
    if (b <= 0x9f) return arr(b & 0x0f);
    if (b <= 0xbf) return str(b & 0x1f);
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xcc: return dv.getUint8(pos++);
      case 0xcd: { const v = dv.getUint16(pos); pos += 2; return v; }
      case 0xce: { const v = dv.getUint32(pos); pos += 4; return v; }
      case 0xcf: { const v = dv.getBigUint64(pos); pos += 8; return big(v); }
      case 0xd0: return dv.getInt8(pos++);
      case 0xd1: { const v = dv.getInt16(pos); pos += 2; return v; }
      case 0xd2: { const v = dv.getInt32(pos); pos += 4; return v; }
      case 0xd3: { const v = dv.getBigInt64(pos); pos += 8; return big(v); }
      case 0xca: { const v = dv.getFloat32(pos); pos += 4; return v; }
      case 0xcb: { const v = dv.getFloat64(pos); pos += 8; return v; }
      case 0xd9: { const l = dv.getUint8(pos++); return str(l); }
      case 0xda: { const l = dv.getUint16(pos); pos += 2; return str(l); }
      case 0xdb: { const l = dv.getUint32(pos); pos += 4; return str(l); }
      case 0xc4: { const l = dv.getUint8(pos++); return bin(l); }
      case 0xc5: { const l = dv.getUint16(pos); pos += 2; return bin(l); }
      case 0xc6: { const l = dv.getUint32(pos); pos += 4; return bin(l); }
      case 0xdc: { const l = dv.getUint16(pos); pos += 2; return arr(l); }
      case 0xdd: { const l = dv.getUint32(pos); pos += 4; return arr(l); }
      case 0xde: { const l = dv.getUint16(pos); pos += 2; return map(l); }
      case 0xdf: { const l = dv.getUint32(pos); pos += 4; return map(l); }
      default: throw new Error(`unsupported msgpack byte 0x${b.toString(16)}`);
    }
  }
  const result = read();
  if (pos !== bytes.length) throw new Error("trailing bytes"); // guards against false positives
  return result;
}

// --- payload encoding (Publisher) -------------------------------------------
// Symmetric with the decoders above so the Publisher can compose every format
// the viewer can render.

/** Base64-encode raw bytes (btoa over a binary string). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Encode a JSON-compatible value to MessagePack bytes (common subset). Throws
 *  on values it can't represent. Inverse of `decodeMsgpack`. */
export function encodeMsgpack(value: unknown): Uint8Array {
  const out: number[] = [];
  const te = new TextEncoder();
  const u16 = (n: number): void => void out.push((n >> 8) & 0xff, n & 0xff);
  const u32 = (n: number): void => void out.push((n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  const bytes = (b: Uint8Array): void => {
    for (const x of b) out.push(x);
  };
  const write = (v: unknown): void => {
    if (v === null || v === undefined) return void out.push(0xc0);
    if (v === true) return void out.push(0xc3);
    if (v === false) return void out.push(0xc2);
    if (typeof v === "number") {
      if (Number.isInteger(v) && Math.abs(v) <= 0xffffffff) {
        if (v >= 0) {
          if (v <= 0x7f) out.push(v);
          else if (v <= 0xff) out.push(0xcc, v);
          else if (v <= 0xffff) (out.push(0xcd), u16(v));
          else (out.push(0xce), u32(v));
        } else if (v >= -32) out.push(v & 0xff);
        else if (v >= -128) out.push(0xd0, v & 0xff);
        else if (v >= -32768) (out.push(0xd1), u16(v & 0xffff));
        else (out.push(0xd2), u32(v >>> 0));
      } else {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setFloat64(0, v);
        out.push(0xcb);
        bytes(b);
      }
      return;
    }
    if (typeof v === "string") {
      const b = te.encode(v);
      if (b.length <= 0x1f) out.push(0xa0 | b.length);
      else if (b.length <= 0xff) out.push(0xd9, b.length);
      else if (b.length <= 0xffff) (out.push(0xda), u16(b.length));
      else (out.push(0xdb), u32(b.length));
      bytes(b);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length <= 0x0f) out.push(0x90 | v.length);
      else if (v.length <= 0xffff) (out.push(0xdc), u16(v.length));
      else (out.push(0xdd), u32(v.length));
      for (const item of v) write(item);
      return;
    }
    if (typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length <= 0x0f) out.push(0x80 | entries.length);
      else if (entries.length <= 0xffff) (out.push(0xde), u16(entries.length));
      else (out.push(0xdf), u32(entries.length));
      for (const [k, val] of entries) (write(k), write(val));
      return;
    }
    throw new Error(`cannot encode ${typeof v} to MessagePack`);
  };
  write(value);
  return new Uint8Array(out);
}

/** Encode a flat `{ "<fieldNumber>": value }` object to protobuf wire bytes:
 *  integer→varint, boolean→varint(0/1), string→length-delimited. Schema-less,
 *  inverse of `decodeProto`. Throws on unsupported values / field numbers. */
export function encodeProtoWire(obj: Record<string, unknown>): Uint8Array {
  const out: number[] = [];
  const te = new TextEncoder();
  const varint = (value: bigint): void => {
    let v = value & ((1n << 64n) - 1n);
    do {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v !== 0n) byte |= 0x80;
      out.push(byte);
    } while (v !== 0n);
  };
  for (const [key, val] of Object.entries(obj)) {
    const field = Number(key);
    if (!Number.isInteger(field) || field < 1) throw new Error(`invalid field number "${key}" (use positive integers)`);
    if (typeof val === "boolean") {
      varint(BigInt(field * 8));
      varint(val ? 1n : 0n);
    } else if (typeof val === "number" && Number.isInteger(val)) {
      varint(BigInt(field * 8));
      varint(BigInt(val));
    } else if (typeof val === "string") {
      const b = te.encode(val);
      varint(BigInt(field * 8 + 2));
      varint(BigInt(b.length));
      for (const x of b) out.push(x);
    } else {
      throw new Error(`field ${field}: unsupported value (use integer, boolean, or string)`);
    }
  }
  return new Uint8Array(out);
}

/** Payload viewer: format tabs (JSON / Text / Hex / Protobuf / MessagePack / Base64) + copy. */
export function PayloadView({ view, className }: { view: MessageView; className?: string }): JSX.Element {
  const bytes = useMemo(() => b64ToBytes(view.payloadBase64), [view.payloadBase64]);
  const compressed = view.compression !== "none";
  const [copied, setCopied] = useState(false);

  const looksMsgpack = (b: Uint8Array): boolean => {
    if (b.length === 0) return false;
    try {
      decodeMsgpack(b);
      return true;
    } catch {
      return false;
    }
  };
  const defaultMode: Mode =
    view.format === "json" ? "json" : view.format === "binary" ? (looksMsgpack(bytes) ? "msgpack" : "hex") : "text";
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
      case "msgpack":
        try {
          return JSON.stringify(decodeMsgpack(bytes), null, 2);
        } catch {
          return "(not a valid MessagePack message)";
        }
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

  const modes: Mode[] = ["json", "text", "hex", "proto", "msgpack", "base64"];
  const label = (m: Mode): string =>
    m === "proto" ? "Protobuf" : m === "msgpack" ? "MessagePack" : m === "base64" ? "Base64" : m === "json" ? "JSON" : m;

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

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex flex-wrap rounded-lg border border-border bg-surface-2 p-0.5">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cx(
                "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                mode === m ? "bg-accent text-accent-content shadow-sm" : "text-muted hover:text-content",
              )}
            >
              {label(m)}
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
