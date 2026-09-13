/**
 * Unit tests for the protocol handshake (#31): the gate state machine, negotiation over wire-mesh-core, and the state-sync wire tolerance.
 */

import * as net from "node:net";
import { describe, it, expect } from "vitest";
import { encode as cborEncode, cdeEncodeOptions } from "cbor2";
import {
  AGENT_COMMS_DOMAIN,
  ConnectionHandshake,
  MESH_PROTOCOL_VERSION,
  attachSocketHandshake,
  encodeHandshakeFrame,
  negotiateMeshProtocol,
} from "../core/handshake.js";
import {
  normaliseWireState,
  type SerialisedState,
} from "../core/wire-protocol.js";

describe("negotiateMeshProtocol", () => {
  it("negotiates down to the lower version with the shared domain", () => {
    const result = negotiateMeshProtocol({
      type: "handshake",
      version: MESH_PROTOCOL_VERSION + 1,
      domains: [AGENT_COMMS_DOMAIN],
    });
    expect(result.ok).toBe(true);
    expect(result.version).toBe(MESH_PROTOCOL_VERSION);
    expect(result.sharedDomains).toEqual([AGENT_COMMS_DOMAIN]);
  });

  it("refuses a peer with no shared domain", () => {
    const result = negotiateMeshProtocol({
      type: "handshake",
      version: MESH_PROTOCOL_VERSION,
      domains: ["example.com/something-else"],
    });
    expect(result.ok).toBe(false);
  });
});

describe("ConnectionHandshake", () => {
  it("classifies a peer frame as negotiated and returns trailing JSON bytes", () => {
    const gate = new ConnectionHandshake("server");
    const frame = encodeHandshakeFrame();
    const jsonTail = Buffer.from('{"method":"introduce"}\n', "utf8");
    const outcome = gate.feed(Buffer.concat([frame, jsonTail]));
    expect(outcome.kind).toBe("negotiated");
    if (outcome.kind !== "negotiated") return;
    expect(outcome.result.version).toBe(MESH_PROTOCOL_VERSION);
    expect(outcome.rest.toString()).toBe(jsonTail.toString());
    // Subsequent feeds pass through unchanged.
    const more = gate.feed(Buffer.from("{}", "utf8"));
    expect(more.kind).toBe("negotiated");
    if (more.kind !== "negotiated") return;
    expect(more.rest.toString()).toBe("{}");
  });

  it("reassembles a frame split across TCP-sized chunks", () => {
    const gate = new ConnectionHandshake("server");
    const frame = Buffer.from(encodeHandshakeFrame());
    const split = Math.floor(frame.length / 2);
    expect(gate.feed(frame.subarray(0, split)).kind).toBe("pending");
    const outcome = gate.feed(frame.subarray(split));
    expect(outcome.kind).toBe("negotiated");
  });

  it("classifies a JSON-first-byte connection as legacy and passes bytes through", () => {
    const gate = new ConnectionHandshake("server");
    const outcome = gate.feed(Buffer.from('{"method":"introduce"}\n', "utf8"));
    expect(outcome.kind).toBe("legacy");
    if (outcome.kind !== "legacy") return;
    expect(outcome.rest.toString()).toMatch(/introduce/);
  });

  it("refuses a handshake whose negotiation fails (no shared domain)", () => {
    const gate = new ConnectionHandshake("server");
    const hostile = cborEncode(
      { type: "handshake", version: 1, domains: ["example.com/other"] },
      cdeEncodeOptions,
    );
    const outcome = gate.feed(Buffer.from(hostile));
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason).toMatch(/no shared domain/);
  });

  it("refuses a CBOR item that is not a handshake frame", () => {
    const gate = new ConnectionHandshake("server");
    const notAHandshake = cborEncode({ hello: "world" }, cdeEncodeOptions);
    const outcome = gate.feed(Buffer.from(notAHandshake));
    expect(outcome.kind).toBe("refused");
  });

  it("refuses undecodable leading bytes that are neither CBOR maps nor JSON", () => {
    const gate = new ConnectionHandshake("server");
    const outcome = gate.feed(Buffer.from([0xff, 0x00, 0x01]));
    expect(outcome.kind).toBe("refused");
  });

  it("refuses a binary blob far beyond any handshake frame size", () => {
    const gate = new ConnectionHandshake("server");
    const big = Buffer.alloc(2048, 0x61); // 'a' — neither CBOR map head nor '{'
    expect(gate.feed(big).kind).toBe("refused");
  });
});

describe("normaliseWireState (#31 direction 2)", () => {
  it("defaults missing deliveryQueues and entity versions for old-build snapshots", () => {
    const legacy = {
      agents: {
        a1: { id: "a1", name: "a", version: undefined },
      },
      rooms: {},
      messages: {},
      dms: {},
    } as unknown as Parameters<typeof normaliseWireState>[0];
    const normalised = normaliseWireState(legacy);
    expect(normalised.deliveryQueues).toEqual({});
    expect((normalised.agents.a1 as { version: number }).version).toBe(1);
  });

  it("passes a complete modern state through unchanged", () => {
    // Deliberately loose (matching the "legacy" fixture above): this test asserts only the four fields normaliseWireState touches, not a fully valid AgentIdentity/Room for every other field those domain types carry.
    const modern = {
      agents: { a1: { id: "a1", version: 3 } },
      rooms: { r1: { id: "r1", version: 2 } },
      messages: {},
      dms: {},
      deliveryQueues: { a1: [] },
    } as unknown as SerialisedState;
    expect(normaliseWireState(modern)).toEqual(modern);
  });
});

// A live gate over a real socket pair: the client frame goes out first; the server classifies on receipt and replies; the client then sees the reply.
describe("ConnectionHandshake over a real socket pair", () => {
  it("client sends frame first; both sides reach negotiated", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as net.AddressInfo).port;

    const serverOutcome = new Promise<"negotiated" | "legacy" | "refused">(
      (resolve) => {
        server.on("connection", (socket) => {
          const gate = new ConnectionHandshake("server");
          socket.on("data", (data: Buffer) => {
            const outcome = gate.feed(data);
            if (outcome.kind !== "pending") {
              if (outcome.kind === "negotiated") {
                socket.write(encodeHandshakeFrame());
              }
              resolve(outcome.kind);
            }
          });
        });
      },
    );

    const client = net.createConnection({ port, host: "127.0.0.1" });
    const clientGate = new ConnectionHandshake("client");
    const clientOutcome = new Promise<"negotiated" | "legacy" | "refused">(
      (resolve) => {
        client.on("data", (data: Buffer) => {
          const outcome = clientGate.feed(data);
          if (outcome.kind !== "pending") resolve(outcome.kind);
        });
      },
    );
    client.write(encodeHandshakeFrame());

    expect(await serverOutcome).toBe("negotiated");
    expect(await clientOutcome).toBe("negotiated");

    client.destroy();
    server.close();
  });

  it("a legacy peer (no handshake frame) is tolerated: JSON bytes pass straight through both sides", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as net.AddressInfo).port;

    const serverReceived = new Promise<string>((resolve, reject) => {
      server.on("connection", (socket) => {
        attachSocketHandshake(
          socket,
          "server",
          (data) => resolve(data.toString()),
          reject,
        );
      });
    });

    // A pre-#31 peer: writes its JSON line directly, sends no handshake frame at all.
    const client = net.createConnection({ port, host: "127.0.0.1" });
    await new Promise<void>((resolve) => client.on("connect", resolve));
    client.write('{"method":"introduce"}\n');

    expect(await serverReceived).toMatch(/introduce/);

    client.destroy();
    server.close();
  });

  it("an incompatible handshake (no shared domain) is refused loudly: the connection is destroyed rather than desynced", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as net.AddressInfo).port;

    const serverError = new Promise<Error>((resolve) => {
      server.on("connection", (socket) => {
        attachSocketHandshake(
          socket,
          "server",
          () => {
            throw new Error(
              "payload should never be reached on a refused handshake",
            );
          },
          resolve,
        );
      });
    });

    const client = net.createConnection({ port, host: "127.0.0.1" });
    await new Promise<void>((resolve) => client.on("connect", resolve));
    const foreignFrame = cborEncode(
      {
        type: "handshake",
        version: MESH_PROTOCOL_VERSION,
        domains: ["example.com/unrelated-mesh"],
      },
      cdeEncodeOptions,
    );
    client.write(Buffer.from(foreignFrame));

    const error = await serverError;
    expect(error.message).toMatch(/no shared domain/);

    await new Promise<void>((resolve) => {
      client.on("close", resolve);
      client.on("error", () => resolve());
    });
    server.close();
  });
});
