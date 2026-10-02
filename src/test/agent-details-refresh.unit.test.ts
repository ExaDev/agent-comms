/**
 * The exchange's refresh loop (agent-comms#323): which listed agents it asks, what it caches, and what it leaves alone, against a fake transport standing in for the send.
 */

import { describe, expect, it } from "vitest";
import { AgentDetailsExchange } from "../core/agent-details.js";
import type { AgentIdentity } from "../core/types.js";
import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";

const SELF = "self";
const TRUSTED_REMOTE = "trusted-remote";
const UNTRUSTED_REMOTE = "untrusted-remote";

/** Long enough for the fake transport's promise chain to settle between the check points. */
const SETTLE_MS = 20;
/** Long enough for one 250ms retry to have happened. */
const RETRY_SETTLE_MS = 400;

async function settle(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function agentOf(id: string, cwd: string): AgentIdentity {
  return {
    id,
    version: 1,
    name: id,
    harness: "test",
    cwd,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    visibility: "visible",
    status: "active",
    tags: [],
    subscribedRooms: [],
  };
}

/** Records every send and answers each with a canned outcome, defaulting to a plain ok carrying the target's own details. */
function fakeTransport(
  outcomes: Readonly<Record<string, ManageOutcome>> = {},
): {
  sentTo: string[];
  transport: { sendRoomRequest: (peerId: string) => Promise<ManageOutcome> };
} {
  const sentTo: string[] = [];
  return {
    sentTo,
    transport: {
      sendRoomRequest: async (peerId: string) => {
        sentTo.push(peerId);
        return (
          outcomes[peerId] ?? {
            result: "ok",
            cwd: `/fetched/${peerId}`,
            tags: [],
            rooms: [],
          }
        );
      },
    },
  };
}

function exchangeOf(
  transport: Readonly<{
    sendRoomRequest: (peerId: string) => Promise<ManageOutcome>;
  }>,
  trusted: readonly string[] = [TRUSTED_REMOTE],
): AgentDetailsExchange {
  return new AgentDetailsExchange({
    selfAgent: () => agentOf(SELF, "/test/self"),
    hostedRooms: () => [],
    isTrusted: (deviceHex) => trusted.includes(deviceHex),
    requireTransport: () => transport,
  });
}

describe("AgentDetailsExchange.refresh", () => {
  it("asks a trusted remote agent whose details a hub session withholds, and caches the answer", async () => {
    const { sentTo, transport } = fakeTransport();
    const exchange = exchangeOf(transport);
    exchange.refresh([agentOf(TRUSTED_REMOTE, "")], SELF);
    await settle(SETTLE_MS);
    expect(sentTo).toEqual([TRUSTED_REMOTE]);
    expect(exchange.cached(TRUSTED_REMOTE)?.cwd).toBe(
      `/fetched/${TRUSTED_REMOTE}`,
    );
  });

  it("never asks for itself, for an untrusted remote, or for an agent whose details are already shared", async () => {
    const { sentTo, transport } = fakeTransport();
    const exchange = exchangeOf(transport);
    exchange.refresh(
      [
        agentOf(SELF, ""),
        agentOf(UNTRUSTED_REMOTE, ""),
        agentOf(TRUSTED_REMOTE, "/already/shared"),
      ],
      SELF,
    );
    await settle(SETTLE_MS);
    expect(sentTo).toEqual([]);
    expect(exchange.cached(SELF)).toBeUndefined();
    expect(exchange.cached(UNTRUSTED_REMOTE)).toBeUndefined();
    expect(exchange.cached(TRUSTED_REMOTE)).toBeUndefined();
  });

  it("caches nothing for a refusal and retries a transient no-route within the window", async () => {
    let attempts = 0;
    const transport = {
      sendRoomRequest: async (): Promise<ManageOutcome> => {
        attempts += 1;
        return attempts === 1
          ? { result: "error", code: "no_route" }
          : { result: "error", code: "untrusted_requester" };
      },
    };
    const exchange = exchangeOf(transport);
    exchange.refresh([agentOf(TRUSTED_REMOTE, "")], SELF);
    await settle(RETRY_SETTLE_MS);
    expect(attempts).toBe(2);
    expect(exchange.cached(TRUSTED_REMOTE)).toBeUndefined();
  });

  it("drops a cached entry once its agent leaves the listing", async () => {
    const { transport } = fakeTransport();
    const exchange = exchangeOf(transport);
    exchange.refresh([agentOf(TRUSTED_REMOTE, "")], SELF);
    await settle(SETTLE_MS);
    expect(exchange.cached(TRUSTED_REMOTE)).toBeDefined();
    exchange.refresh([], SELF);
    expect(exchange.cached(TRUSTED_REMOTE)).toBeUndefined();
  });
});
