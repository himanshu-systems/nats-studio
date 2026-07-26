import { describe, expect, it } from "vitest";
import type { MessageHeader, MessageView } from "@bindings";
import { ErrorCode, NatsStudioError } from "@bindings";
import {
  b64ToBytes,
  bytesToBase64,
  decodeMsgpack,
  decodeProto,
  encodeMsgpack,
  encodeProtoWire,
  errorMessage,
  explainError,
  fmtBytes,
  headersToRaw,
  hexdump,
  parseHeaders,
  toCsv,
  toJson,
} from "./message";

function mkNatsError(overrides: Partial<ConstructorParameters<typeof NatsStudioError>[0]> = {}): NatsStudioError {
  return new NatsStudioError({
    code: ErrorCode.Internal,
    message: "boom",
    retriable: false,
    causes: [],
    ...overrides,
  });
}

function mkView(overrides: Partial<MessageView> = {}): MessageView {
  return {
    seq: 1,
    subject: "orders.new",
    headers: [],
    payloadBase64: btoa("hello"),
    size: 5,
    format: "text",
    compression: "none",
    preview: "hello",
    ts: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("errorMessage", () => {
  it("formats a NatsStudioError as CODE: message", () => {
    expect(errorMessage(mkNatsError({ code: ErrorCode.StreamNotFound, message: "no such stream" }))).toBe(
      "STREAM_NOT_FOUND: no such stream",
    );
  });

  it("uses the message of a plain Error", () => {
    expect(errorMessage(new Error("plain failure"))).toBe("plain failure");
  });

  it("stringifies a non-Error throw", () => {
    expect(errorMessage("just a string")).toBe("just a string");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("explainError", () => {
  it("uses the known-code summary/hint and joins causes into detail", () => {
    const e = mkNatsError({ code: ErrorCode.StreamNotFound, message: "raw msg", causes: ["cause A", "cause B"] });
    const explained = explainError(e);
    expect(explained.code).toBe("STREAM_NOT_FOUND");
    expect(explained.summary).toBe("Stream not found.");
    expect(explained.hint).toContain("just been deleted");
    expect(explained.detail).toBe("STREAM_NOT_FOUND: raw msg\ncause A\ncause B");
  });

  it("falls back to a transient-retry hint for codes with no curated hint", () => {
    const explained = explainError(mkNatsError({ code: ErrorCode.Internal, retriable: true }));
    expect(explained.hint).toBe("This looks transient — safe to retry.");
  });

  it("falls back to a generic hint for non-retriable codes with no curated hint", () => {
    const explained = explainError(mkNatsError({ code: ErrorCode.Internal, retriable: false }));
    expect(explained.hint).toBe("See details below.");
  });

  it("handles a non-NatsStudioError with a null code", () => {
    const explained = explainError(new Error("weird failure"));
    expect(explained.code).toBeNull();
    expect(explained.summary).toBe("weird failure");
    expect(explained.retriable).toBe(false);
  });
});

describe("fmtBytes", () => {
  it("keeps sub-1024 values in bytes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1023)).toBe("1023 B");
  });

  it("steps up units at each 1024 boundary", () => {
    expect(fmtBytes(1024)).toBe("1.0 KiB");
    expect(fmtBytes(1536)).toBe("1.5 KiB");
    expect(fmtBytes(1024 * 1024)).toBe("1.0 MiB");
    expect(fmtBytes(1024 * 1024 * 1024)).toBe("1.0 GiB");
  });

  it("caps at TiB instead of overflowing the unit table", () => {
    expect(fmtBytes(1024 ** 5)).toBe("1024.0 TiB");
  });
});

describe("parseHeaders / headersToRaw", () => {
  it("parses Key: Value lines, trimming whitespace", () => {
    expect(parseHeaders("X-Trace-Id:  abc123 \nContent-Type: application/json")).toEqual([
      { name: "X-Trace-Id", value: "abc123" },
      { name: "Content-Type", value: "application/json" },
    ]);
  });

  it("skips blank lines and lines without a colon", () => {
    expect(parseHeaders("X-A: 1\n\n   \nnot-a-header\nX-B: 2")).toEqual([
      { name: "X-A", value: "1" },
      { name: "X-B", value: "2" },
    ]);
  });

  it("drops entries with an empty name (a bare leading colon)", () => {
    expect(parseHeaders(": no name")).toEqual([]);
  });

  it("keeps only the first colon as the delimiter (values may contain colons)", () => {
    expect(parseHeaders("X-Url: http://example.com:8080")).toEqual([
      { name: "X-Url", value: "http://example.com:8080" },
    ]);
  });

  it("round-trips through headersToRaw", () => {
    const headers: MessageHeader[] = [
      { name: "X-A", value: "1" },
      { name: "X-B", value: "2" },
    ];
    expect(parseHeaders(headersToRaw(headers))).toEqual(headers);
  });
});

describe("bytesToBase64 / b64ToBytes", () => {
  it("round-trips arbitrary bytes", () => {
    const original = new Uint8Array([0, 1, 2, 127, 128, 255, 42]);
    expect(b64ToBytes(bytesToBase64(original))).toEqual(original);
  });

  it("decodes an empty string to an empty array, not a throw", () => {
    expect(b64ToBytes("")).toEqual(new Uint8Array());
  });

  it("returns an empty array for invalid base64 instead of throwing", () => {
    expect(b64ToBytes("not valid base64!!")).toEqual(new Uint8Array());
  });
});

describe("hexdump", () => {
  it("renders offset, hex bytes, and an ASCII gutter with '.' for non-printables", () => {
    const bytes = new Uint8Array([0x41, 0x42, 0x00, 0x43]); // "AB\0C"
    const out = hexdump(bytes);
    expect(out).toContain("00000000");
    expect(out).toContain("41 42 00 43");
    expect(out).toContain("AB.C");
  });

  it("notes how many bytes were truncated beyond the render cap", () => {
    const bytes = new Uint8Array(64 * 1024 + 10);
    expect(hexdump(bytes)).toContain("10 more bytes");
  });
});

describe("decodeProto / encodeProtoWire round trip", () => {
  it("round-trips varint, length-delimited string, and boolean fields", () => {
    const encoded = encodeProtoWire({ 1: 42, 2: "hello", 3: true });
    const decoded = decodeProto(encoded);
    expect(decoded).toContain('1: varint  42');
    expect(decoded).toContain('2: len=5  "hello"');
    expect(decoded).toContain("3: varint  1");
  });

  it("rejects a non-positive-integer field number", () => {
    expect(() => encodeProtoWire({ 0: 1 })).toThrow(/invalid field number/);
    expect(() => encodeProtoWire({ "-1": 1 })).toThrow(/invalid field number/);
  });

  it("rejects an unsupported value type", () => {
    expect(() => encodeProtoWire({ 1: { nested: true } as unknown as string })).toThrow(/unsupported value/);
  });

  it("returns null for bytes that aren't valid protobuf wire format", () => {
    expect(decodeProto(new Uint8Array([0xff]))).toBeNull();
  });
});

describe("decodeMsgpack / encodeMsgpack round trip", () => {
  it.each([
    ["null", null],
    ["true", true],
    ["false", false],
    ["a small positive int", 5],
    ["a negative int", -20],
    ["a string", "hello world"],
    ["an array", [1, 2, 3]],
    ["a nested object", { a: 1, b: { c: [true, false, null] } }],
    ["a float", 3.5],
    ["a large uint requiring 32-bit encoding", 70000],
  ])("round-trips %s", (_label, value) => {
    expect(decodeMsgpack(encodeMsgpack(value))).toEqual(value);
  });

  it("throws on an unsupported byte instead of returning garbage", () => {
    expect(() => decodeMsgpack(new Uint8Array([0xc1]))).toThrow(/unsupported msgpack byte/);
  });

  it("throws on trailing bytes after a complete value", () => {
    const one = encodeMsgpack(1);
    const withTrailer = new Uint8Array([...one, ...one]);
    expect(() => decodeMsgpack(withTrailer)).toThrow(/trailing bytes/);
  });

  it("throws encoding a value it can't represent", () => {
    expect(() => encodeMsgpack(() => {})).toThrow(/cannot encode/);
  });
});

describe("toCsv / toJson", () => {
  it("emits a header row plus one row per message", () => {
    const csv = toCsv([mkView({ seq: 1, subject: "a" }), mkView({ seq: 2, subject: "b" })]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("seq,subject,timestamp,size,payload");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("a");
    expect(lines[2]).toContain("b");
  });

  it("quotes CSV fields containing commas, quotes, or newlines per RFC 4180", () => {
    const csv = toCsv([mkView({ preview: 'has,comma and "quote"\nand newline' })]);
    expect(csv).toContain('"has,comma and ""quote""\nand newline"');
  });

  it("exports the base64 payload (not the preview) for binary messages", () => {
    const view = mkView({ format: "binary", preview: "should not appear", payloadBase64: "QkJC" });
    expect(toCsv([view])).toContain("QkJC");
    expect(toCsv([view])).not.toContain("should not appear");
  });

  it("produces valid, round-trippable JSON carrying headers", () => {
    const view = mkView({ headers: [{ name: "X-A", value: "1" }] });
    const parsed = JSON.parse(toJson([view])) as Array<{ headers: MessageHeader[]; payload: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.headers).toEqual([{ name: "X-A", value: "1" }]);
    expect(parsed[0]!.payload).toBe("hello");
  });
});
