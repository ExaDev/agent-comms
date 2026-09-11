/**
 * Protocol handshake — version negotiation for the mesh wire format, fixing #31: a mixed fleet of old and new peers negotiates down to what both actually support (or refuses loudly) instead of one side silently misinterpreting the other's state sync.
 *
 * The frame is wire-mesh's handshake-frame (spec/handshake.cddl in ExaDev/wire-mesh), CBOR-encoded, negotiated by wire-mesh-core's `negotiate()` — the same mechanism every wire-mesh consumer speaks. The `version` field carries agent-comms' own wire-format version (not wire-mesh's protocol version): version 1 is the current format, the one with entity revision fields (#29) and deliveryQueues (#30). A peer that never sends a handshake frame is a legacy peer (version 0, unversioned) and the connection proceeds exactly as before — mixed-fleet tolerance during rollout, the scenario #31 describes.
 *
 * Wire order: a client sends its handshake frame as the very first bytes on a connection and does not wait — the rest of its traffic is ordinary newline-delimited JSON. A server sends its frame only in reply to a received one, so legacy clients never see binary bytes at all. The one unavoidable cross-build artefact is a legacy server receiving a new client's CBOR frame into its line buffer, where it lands without a newline and is flushed as a single malformed (skipped) line when the first JSON message arrives — the pre-existing malformed-line behaviour.
 */

import {
  decodeSequence,
  encode as cborEncode,
  cdeDecodeOptions,
  cdeEncodeOptions,
} from "cbor2";
import {
  negotiate,
  type NegotiationResult,
} from "wire-mesh-core/domain/handshake";

/** agent-comms' own wire-format version. 1 = the current format (entity revision fields, deliveryQueues). */
export const MESH_PROTOCOL_VERSION = 1;

/**
 * The capability domain this mesh negotiates under — a wire-mesh namespaced-domain-id (registrant-owned, no allocator): ExaDev's agent-comms mesh semantics. Peers that do not share it are not this protocol.
 */
export const AGENT_COMMS_DOMAIN = "dev.exadev.agent-comms/mesh";

/** Handshake frames are tiny; anything larger than this is not a frame, it is garbage. */
const MAX_HANDSHAKE_BYTES = 1024;

/** CBOR map head byte range (0xa0–0xbf); JSON always starts with '{' (0x7b). */
function isCborMapHead(byte: number): boolean {
  return byte >= 0xa0 && byte <= 0xbf;
}

const JSON_OBJECT_START = 0x7b; // '{'

interface HandshakeShape {
  type: "handshake";
  version: number;
  domains: string[];
}

/**
 * Narrow structural check for a received handshake frame.
 *
 * Deliberately NOT the generated handshakeFrameSchema: its domain union's regexp branches are emitted double-escaped by cddl.js (ExaDev/cddl.js#10), so schema-validating any namespaced domain — including ours — rejects valid frames until that fix lands. This guard checks exactly the shape `negotiate()` consumes.
 */
function isHandshakeShape(value: unknown): value is HandshakeShape {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value) || value.type !== "handshake") return false;
  if (!("version" in value) || typeof value.version !== "number") return false;
  if (!("domains" in value) || !Array.isArray(value.domains)) return false;
  return value.domains.every((d) => typeof d === "string");
}

function localFrame(): HandshakeShape {
  return {
    type: "handshake",
    version: MESH_PROTOCOL_VERSION,
    domains: [AGENT_COMMS_DOMAIN],
  };
}

/** The handshake frame this build sends, CBOR-encoded (canonical), ready to write as a connection's first bytes. */
export function encodeHandshakeFrame(): Uint8Array {
  return cborEncode(localFrame(), cdeEncodeOptions);
}

/** Negotiates this build's protocol against a received handshake frame — core's negotiation over agent-comms' versions. */
export function negotiateMeshProtocol(
  remote: HandshakeShape,
): NegotiationResult {
  return negotiate(localFrame(), remote);
}

export type HandshakeOutcome =
  | { kind: "pending" }
  | { kind: "legacy"; rest: Buffer; reason: "json-first-byte" }
  | { kind: "negotiated"; rest: Buffer; result: NegotiationResult }
  | { kind: "refused"; reason: string };

/**
 * Per-connection gate fed the incoming byte stream. Consumes the (optional) leading handshake frame and classifies the connection: negotiated (a version was agreed — for a server, the caller replies with `encodeHandshakeFrame()`), legacy (first byte was '{' — a pre-handshake peer, proceed exactly as before), or refused (a handshake we cannot speak: destroy the connection loudly rather than desync — the #31 enforcement point). After the first classification every subsequent feed passes the bytes through unchanged.
 */
export class ConnectionHandshake {
  private decided: "legacy" | "negotiated" | null = null;
  private pending: Buffer[] = [];
  private pendingLength = 0;

  constructor(private readonly role: "client" | "server") {}

  feed(data: Buffer): HandshakeOutcome {
    if (this.decided !== null) {
      if (this.decided === "negotiated") {
        return {
          kind: "negotiated",
          rest: data,
          result: this.negotiatedResult(),
        };
      }
      return { kind: "legacy", rest: data, reason: "json-first-byte" };
    }
    // The connection's very first byte only classifies legacy vs. CBOR. A later chunk (the second half of a split frame) starts mid-item, and its own leading byte is not a fresh frame head -- re-checking it against isCborMapHead on every chunk was the bug a reassembly test caught.
    if (this.pending.length === 0) {
      const first = data[0];
      if (first === undefined) {
        return { kind: "pending" };
      }
      if (first === JSON_OBJECT_START) {
        this.decided = "legacy";
        return { kind: "legacy", rest: data, reason: "json-first-byte" };
      }
      if (!isCborMapHead(first)) {
        return {
          kind: "refused",
          reason: `unexpected first byte 0x${first.toString(16)} — not a handshake frame or JSON message`,
        };
      }
    }
    // A CBOR item: accumulate until it decodes (frames are tiny; TCP may split them).
    this.pending.push(data);
    this.pendingLength += data.length;
    if (this.pendingLength > MAX_HANDSHAKE_BYTES) {
      return {
        kind: "refused",
        reason: `handshake frame exceeds ${String(MAX_HANDSHAKE_BYTES)} bytes`,
      };
    }
    const joined = Buffer.concat(this.pending);
    let value: unknown;
    try {
      // decodeSequence yields lazily: its first item resolves as soon as enough bytes exist for it, tolerating (rather than choking on) non-CBOR bytes that follow in the same buffer -- the ordinary case once a client's JSON traffic lands in the same TCP read as the frame. Plain decode() throws "Extra data in input" the instant anything trails the item, which would misclassify every such read as still-pending forever.
      const item = decodeSequence(joined, cdeDecodeOptions).next();
      if (item.done !== false) {
        return { kind: "pending" };
      }
      value = item.value;
    } catch {
      return { kind: "pending" };
    }
    if (!isHandshakeShape(value)) {
      return {
        kind: "refused",
        reason: "CBOR item on a new connection is not a handshake frame",
      };
    }
    // The frame consumed only its own bytes; anything after it is the stream's JSON traffic.
    const encoded = cborEncode(value, cdeEncodeOptions);
    const rest = joined.subarray(encoded.length);
    const result = negotiateMeshProtocol(value);
    if (!result.ok) {
      return {
        kind: "refused",
        reason: `handshake refused (${this.role}): peer protocol version ${String(value.version)}, no shared domain`,
      };
    }
    this.decided = "negotiated";
    this.lastResult = result;
    return { kind: "negotiated", rest, result };
  }

  private lastResult: NegotiationResult | undefined;

  private negotiatedResult(): NegotiationResult {
    if (this.lastResult === undefined) {
      throw new Error("negotiated connection has no negotiation result");
    }
    return this.lastResult;
  }

  /** True once this connection was classified (legacy or negotiated) — further feed() calls pass through. */
  get settled(): boolean {
    return this.decided !== null;
  }
}

// ---------------------------------------------------------------------------
// Socket attachment (TCP/TLS) — one helper, every connection site
// ---------------------------------------------------------------------------

/** The slice of the Node socket surface the handshake needs — satisfied by net.Socket and tls.TLSSocket alike. */
export interface HandshakeSocket {
  write(data: Uint8Array | string): unknown;
  destroy(): void;
  on(event: "data", listener: (data: Buffer) => void): unknown;
}

/**
 * Wires a connection's handshake: a client sends its frame immediately (and
 * never waits — the rest of its traffic is JSON either way); a server sends
 * its frame only in reply to a received one, so legacy clients never see
 * binary bytes. Payload bytes after classification (and everything on a
 * legacy connection) flow to `onPayload` unchanged. A refused handshake
 * destroys the connection and reports the reason — the loud #31 refusal
 * replacing silent desync.
 */
export function attachSocketHandshake(
  socket: HandshakeSocket,
  role: "client" | "server",
  onPayload: (data: Buffer) => void,
  onError?: (error: Error) => void,
): void {
  const gate = new ConnectionHandshake(role);
  if (role === "client") {
    socket.write(encodeHandshakeFrame());
  }
  // A settled connection reports "negotiated" (or "legacy") on every subsequent feed, not just the classifying one -- feed() has no separate signal for "just decided" versus "already decided, passing through". Without this guard the server branch below wrote a fresh reply frame on every single data event for the rest of the connection's life, corrupting the peer's JSON-line buffer with stray CBOR bytes mid-stream.
  let serverReplySent = false;
  socket.on("data", (data: Buffer) => {
    const outcome = gate.feed(data);
    switch (outcome.kind) {
      case "pending":
        return;
      case "legacy":
        onPayload(outcome.rest);
        return;
      case "negotiated":
        if (role === "server" && !serverReplySent) {
          // Reply only once, on evidence the peer speaks the handshake — a legacy client must never receive binary bytes.
          serverReplySent = true;
          socket.write(encodeHandshakeFrame());
        }
        onPayload(outcome.rest);
        return;
      case "refused":
        onError?.(new Error(outcome.reason));
        socket.destroy();
        return;
    }
  });
}

// ---------------------------------------------------------------------------
// WebSocket attachment — binary first message is the handshake
// ---------------------------------------------------------------------------

/**
 * Gate for a WebSocket connection, where every message is already framed: a
 * binary first message is the peer's handshake frame (reply in kind via
 * `sendBinary` when serving), a text first message is a legacy peer's JSON.
 * Binary messages after the first, or a non-handshake binary first message,
 * are refused.
 */
export class WsHandshakeGate {
  private settled = false;

  constructor(
    private readonly role: "client" | "server",
    private readonly sendBinary: (data: Uint8Array) => void,
  ) {}

  /**
   * Classifies one incoming message. `isBinary` is the WS library's own frame-type flag (`ws`'s `message` event passes `(data, isBinary)`), not `typeof raw === "string"`: in Node, `ws` always delivers `data` as a Buffer regardless of whether the frame was sent as text or binary, so a `typeof` check can never see a text frame as a string here and would misclassify every legacy JSON message as an unexpected second handshake. `"payload"` means deliver it to the existing JSON message path (text only); `"consumed"` means it was the handshake and nothing downstream should see it; a throw is the refused case — the caller closes the socket.
   */
  feed(raw: unknown, isBinary: boolean): "payload" | "consumed" {
    if (this.settled) {
      if (!isBinary) return "payload";
      throw new Error(
        "binary message after connection start on a WebSocket mesh connection",
      );
    }
    if (!isBinary) {
      this.settled = true;
      return "payload";
    }
    const bytes =
      raw instanceof Buffer
        ? raw
        : raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : ArrayBuffer.isView(raw)
            ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
            : undefined;
    if (bytes === undefined) {
      throw new Error("unsupported WebSocket message type");
    }
    const gate = new ConnectionHandshake(this.role);
    const outcome = gate.feed(Buffer.from(bytes));
    if (outcome.kind === "pending") {
      throw new Error(
        "handshake frame did not arrive as one WebSocket message",
      );
    }
    if (outcome.kind === "refused") {
      throw new Error(outcome.reason);
    }
    if (outcome.kind === "legacy") {
      // A text-shaped payload cannot reach here (handled above); binary that
      // is not a handshake frame is a refusal in ConnectionHandshake.
      throw new Error(
        "unexpected legacy classification for a binary WebSocket message",
      );
    }
    if (this.role === "server") {
      this.sendBinary(encodeHandshakeFrame());
    }
    if (outcome.rest.length > 0) {
      throw new Error(
        "handshake frame carried trailing bytes in a WebSocket message",
      );
    }
    this.settled = true;
    return "consumed";
  }
}

/** The slice of the WebSocket surface the handshake needs. */
export interface HandshakeWs {
  send(data: string | Uint8Array): unknown;
  terminate(): void;
  // isBinary is the `ws` library's own frame-type flag (its `message` event always passes it as the second argument) -- the only reliable way to tell a text frame from a binary one, since `data` itself arrives as a Buffer in Node either way.
  on(
    event: "message",
    listener: (raw: unknown, isBinary: boolean) => void,
  ): unknown;
}

/**
 * Wires a WebSocket connection's handshake: a client sends its frame as a
 * binary message immediately (before any JSON); a server replies in kind only
 * on receiving one, so legacy clients never see a binary message. Text
 * messages flow to `onText` unchanged; a refused handshake terminates the
 * connection and reports the reason.
 */
export function attachWsHandshake(
  ws: HandshakeWs,
  role: "client" | "server",
  onText: (raw: unknown) => void,
  onError?: (error: Error) => void,
): void {
  const gate = new WsHandshakeGate(role, (data) => {
    ws.send(data);
  });
  if (role === "client") {
    ws.send(encodeHandshakeFrame());
  }
  ws.on("message", (raw: unknown, isBinary: boolean) => {
    try {
      if (gate.feed(raw, isBinary) === "payload") {
        onText(raw);
      }
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
      ws.terminate();
    }
  });
}
