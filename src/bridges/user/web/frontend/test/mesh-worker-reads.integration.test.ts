/**
 * End-to-end integration tests for the three structured one-shot reads (agent-comms#206) across both oRPC legs at once: a real tab MessagePort talks to a real mesh-worker instance, which talks to a real running server over a real WebSocket. Proves the full tab-through-worker-to-server chain actually works, not just each leg in isolation (router.ts's own suite already covers the worker-server leg; tab-router.integration.test.ts already covers the tab-worker leg with no upstream connected at all).
 */
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { ContractRouterClient } from "@orpc/contract";
import { createWebServer, type WebServerHandle } from "../../server.js";
import {
  connect,
  upgradeTabRpcPort,
  ports,
  agents,
  rooms,
} from "../mesh-worker.js";
import type { TabContract } from "../tab-contract.js";

type TabClient = ContractRouterClient<TabContract>;

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

let handle: WebServerHandle | undefined;

async function startServer(): Promise<number> {
  const coordinatorPort = await findFreePort();
  handle = await createWebServer(0, undefined, coordinatorPort);
  await new Promise<void>((resolve) => {
    if (handle?.server.listening === true) {
      resolve();
      return;
    }
    handle?.server.once("listening", () => {
      resolve();
    });
  });
  const addr = handle.server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

function connectTab(): TabClient {
  const { port1, port2 } = new MessageChannel();
  upgradeTabRpcPort(port2);
  port1.start();
  const link = new RPCLink({ port: port1 });
  return createORPCClient(link);
}

/** A device-id is a hex-encoded SHA-256 hash: 32 bytes, 64 hex characters. */
const DEVICE_ID_HEX_LENGTH = 64;

afterEach(async () => {
  ports.clear();
  agents.clear();
  rooms.clear();
  if (handle) {
    handle.wss.close();
    handle.server.close();
    await handle.controller.shutdown();
    handle = undefined;
  }
});

describe("structured reads across the full tab -> worker -> server chain", () => {
  it("getRoomMessages reaches a real sent message through both legs", async () => {
    const port = await startServer();
    connect(`ws://127.0.0.1:${String(port)}/ws/mesh`);

    const tab = connectTab();
    const created = await tab.createRoom({
      name: "worker-reads-room",
      type: "public",
    });
    expect(created.isError).toBe(false);
    const match = /\(([^)]+)\)\.$/.exec(created.content);
    const roomId = match?.[1];
    if (roomId === undefined) throw new Error("could not extract room id");

    const sent = await tab.send({ target: roomId, content: "reads-e2e" });
    expect(sent.isError).toBe(false);

    const messages = await tab.getRoomMessages({ room: roomId });
    expect(messages.some((m) => m.content === "reads-e2e")).toBe(true);
  });

  it("getMeshGraph reaches the real server's topology through both legs", async () => {
    const port = await startServer();
    connect(`ws://127.0.0.1:${String(port)}/ws/mesh`);

    const tab = connectTab();
    const graph = await tab.getMeshGraph({});
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
  });

  it("getMeshTrace reaches the real server's trace result through both legs", async () => {
    const port = await startServer();
    connect(`ws://127.0.0.1:${String(port)}/ws/mesh`);

    const tab = connectTab();
    const result = await tab.getMeshTrace({
      target: "0".repeat(DEVICE_ID_HEX_LENGTH),
    });
    expect(result.outcome.result).toBe("error");
    expect(result.outcome.code).toBe("not_connected");
  });
});
