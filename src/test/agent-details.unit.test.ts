/**
 * The agent-comms/agent-details verb and its cache (agent-comms#323): a trusted peer asking over a relay pairing gets the details a hub session withholds, and anyone else is refused.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_DETAILS_VERB,
  AgentDetailsCache,
  agentDetailsVerbHandler,
  parseAgentDetails,
  type AgentDetails,
  type AgentDetailsDeps,
} from "../core/agent-details.js";
import type {
  CapabilityScope,
  DeviceId,
} from "wire-mesh-core/generated/protocol";
import type { IncomingManageRequest } from "wire-mesh-core/domain/mesh-session";

const TRUSTED_PEER = "aa"; // deviceIdToHex of a one-byte DeviceId, for fromDevice
const UNTRUSTED_PEER = "bb";

function deviceOf(hex: string): DeviceId {
  return new Uint8Array(
    hex.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? [],
  );
}

const DETAILS: AgentDetails = {
  cwd: "/test/machine-b",
  tags: ["nightly"],
  rooms: [{ path: "b-room", name: "B Room", description: "where B works" }],
};

function handlerDeps(
  overrides: Readonly<Partial<AgentDetailsDeps>> = {},
): AgentDetailsDeps {
  return {
    details: () => DETAILS,
    isTrusted: (deviceHex) => deviceHex === TRUSTED_PEER,
    ...overrides,
  };
}

function requestFrom(peerHex: string | undefined): IncomingManageRequest {
  const scope: Readonly<CapabilityScope> = { kind: "node" };
  return {
    requestId: 1,
    command: { verb: "agent:details", params: { verb: AGENT_DETAILS_VERB } },
    scope,
    ...(peerHex === undefined ? {} : { fromDevice: deviceOf(peerHex) }),
    respond: async () => undefined,
  };
}

/** The handle a direct session's dispatch carries: the connection's own authenticated peer. */
const TRUSTED_HANDLE = { id: TRUSTED_PEER };
const UNTRUSTED_HANDLE = { id: UNTRUSTED_PEER };

describe("agentDetailsVerbHandler", () => {
  it("answers a trusted requester with the cwd, tags and hosted rooms", async () => {
    const handler = agentDetailsVerbHandler(handlerDeps());
    const outcome = await handler(requestFrom(TRUSTED_PEER), TRUSTED_HANDLE);
    expect(outcome).toEqual({ result: "ok", ...DETAILS });
  });

  it("refuses a requester this machine does not trust", async () => {
    const handler = agentDetailsVerbHandler(handlerDeps());
    const outcome = await handler(
      requestFrom(UNTRUSTED_PEER),
      UNTRUSTED_HANDLE,
    );
    expect(outcome).toEqual({ result: "error", code: "untrusted_requester" });
  });

  it("answers a direct session whose authenticated peer this machine trusts", async () => {
    const handler = agentDetailsVerbHandler(handlerDeps());
    const outcome = await handler(requestFrom(undefined), TRUSTED_HANDLE);
    expect(outcome).toEqual({ result: "ok", ...DETAILS });
  });

  it("refuses a direct session whose peer this machine does not trust", async () => {
    const handler = agentDetailsVerbHandler(handlerDeps());
    const outcome = await handler(requestFrom(undefined), UNTRUSTED_HANDLE);
    expect(outcome).toEqual({ result: "error", code: "untrusted_requester" });
  });

  it("answers no_agent while this bridge has no registered agent", async () => {
    const handler = agentDetailsVerbHandler(
      handlerDeps({ details: () => undefined }),
    );
    const outcome = await handler(requestFrom(TRUSTED_PEER), TRUSTED_HANDLE);
    expect(outcome).toEqual({ result: "error", code: "no_agent" });
  });
});

describe("parseAgentDetails", () => {
  it("parses an ok outcome with every field present", () => {
    expect(
      parseAgentDetails({
        result: "ok",
        ...DETAILS,
        rooms: [...DETAILS.rooms],
      }),
    ).toEqual(DETAILS);
  });

  it("refuses an error outcome and a malformed ok", () => {
    expect(parseAgentDetails({ result: "error", code: "x" })).toBeUndefined();
    expect(
      parseAgentDetails({ result: "ok", cwd: "/x", tags: "nope", rooms: [] }),
    ).toBeUndefined();
  });
});

describe("AgentDetailsCache", () => {
  it("drops entries whose agent the last listing did not include", () => {
    const cache = new AgentDetailsCache();
    cache.set("gone", DETAILS);
    cache.set("kept", DETAILS);
    cache.retain(new Set(["kept"]));
    expect(cache.get("gone")).toBeUndefined();
    expect(cache.get("kept")).toBeDefined();
  });
});
