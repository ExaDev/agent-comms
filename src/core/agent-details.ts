/**
 * The details a trusted remote peer asks for over a session of its own (agent-comms#323): a hub session publishes only an agent's summary, so its working directory, rooms and tags list elsewhere as not shared. A bridge this machine has chosen to trust may ask for them with the agent-comms/agent-details verb, carried over the relay pairing the two already have so the hub relays bytes it cannot read; the answer is the same summary a direct peer reads from the advert.
 */

import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";
import type { RoomVerbHandler } from "./room-router.js";
import type { MeshTransport } from "./transport.js";
import { detailsShared } from "./agent-registry.js";
import {
  JOIN_ROUTE_RETRY_MS,
  JOIN_ROUTE_WAIT_MS,
  NO_ROUTE_CODES,
} from "./account-join.js";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { AgentIdentity } from "./types.js";
import type { HostedRoomAdvert } from "./gossip-extensions.js";

/** The params.verb a trusted peer's request is dispatched by, keyed per room-router's own convention like account-join's "account.join". */
export const AGENT_DETAILS_VERB = "agent.details";

/** The outer manage-command verb the request rides, which only satisfies manage-command.verb's own capability-verb grammar; the receiving side dispatches on AGENT_DETAILS_VERB, never this. */
export const AGENT_DETAILS_CAPABILITY_VERB = "agent:details";

/** One room as the details answer carries it: the hosted-room facts a direct peer's advert includes, description included. */
export interface AgentDetailsRoom {
  path: string;
  name: string;
  description: string;
}

/** The details a trusted peer gets that a hub session withholds: everything but the summary. */
export interface AgentDetails {
  cwd: string;
  tags: readonly string[];
  rooms: readonly AgentDetailsRoom[];
}

/** What the verb handler needs: this side's own current details (undefined while no agent is registered), and the trust boundary the requester is gated on. */
export interface AgentDetailsDeps {
  details: () => AgentDetails | undefined;
  isTrusted: (deviceHex: string) => boolean;
}

/** Answers the agent.details verb: the full details for a requester this machine trusts by device id, an explicit refusal for anyone else, and no agent yet for a bridge that has not registered. The requester is whoever the transport actually authenticated: the device the end-to-end secure channel named for a relayed request (fromDevice, never an address a hub asserts), or the connection's own authenticated peer for a direct session (the handle's id, which every dispatch path builds from exactly that). */
export function agentDetailsVerbHandler(
  deps: Readonly<AgentDetailsDeps>,
): RoomVerbHandler {
  return async (request, handle) => {
    const requesterHex =
      request.fromDevice !== undefined
        ? deviceIdToHex(request.fromDevice)
        : handle.id;
    if (!deps.isTrusted(requesterHex)) {
      return { result: "error", code: "untrusted_requester" };
    }
    const details = deps.details();
    if (details === undefined) {
      return { result: "error", code: "no_agent" };
    }
    return {
      result: "ok",
      cwd: details.cwd,
      tags: details.tags,
      rooms: details.rooms,
    };
  };
}

/** Narrows an untrusted value into one AgentDetailsRoom. */
function isAgentDetailsRoom(value: unknown): value is AgentDetailsRoom {
  if (typeof value !== "object" || value === null) return false;
  if (!("path" in value) || typeof value.path !== "string") return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  if (!("description" in value) || typeof value.description !== "string") {
    return false;
  }
  return true;
}

/** Narrows a manage outcome into the AgentDetails it carries: an ok outcome whose every field has the expected shape, and nothing else (a refusal, or an answer from a peer running something else). */
export function parseAgentDetails(
  outcome: Readonly<ManageOutcome>,
): AgentDetails | undefined {
  if (outcome.result !== "ok") return undefined;
  if (typeof outcome.cwd !== "string") return undefined;
  if (!Array.isArray(outcome.tags)) return undefined;
  if (outcome.tags.some((tag) => typeof tag !== "string")) return undefined;
  if (!Array.isArray(outcome.rooms)) return undefined;
  const rooms: AgentDetailsRoom[] = [];
  for (const room of outcome.rooms) {
    if (!isAgentDetailsRoom(room)) return undefined;
    rooms.push(room);
  }
  return { cwd: outcome.cwd, tags: outcome.tags, rooms };
}

/** The cache of details this side has asked trusted peers for: refreshed whenever a listing triggers a new fetch, and trimmed to the agents the last listing actually showed so a departed agent's entry does not linger. */
export class AgentDetailsCache {
  private readonly entries = new Map<string, AgentDetails>();

  /** Records (or replaces) the details fetched for one agent. */
  set(agentId: string, details: Readonly<AgentDetails>): void {
    this.entries.set(agentId, { ...details, rooms: [...details.rooms] });
  }

  /** The cached details for one agent, if a fetch has completed. */
  get(agentId: string): Readonly<AgentDetails> | undefined {
    return this.entries.get(agentId);
  }

  /** Drops every entry whose agent the last listing did not include. */
  retain(agentIds: ReadonlySet<string>): void {
    for (const agentId of this.entries.keys()) {
      if (!agentIds.has(agentId)) this.entries.delete(agentId);
    }
  }
}

/** This side's own details for a registered agent and its hosted rooms, the verb's answer body. */
export function ownAgentDetailsOf(
  agent: Readonly<Pick<AgentIdentity, "cwd" | "tags">>,
  hostedRooms: readonly Readonly<HostedRoomAdvert>[],
): AgentDetails {
  return {
    cwd: agent.cwd,
    tags: agent.tags,
    rooms: hostedRooms.map((room) => ({
      path: room.path,
      name: room.name,
      description: room.description,
    })),
  };
}

/** What the exchange needs from the store: this side's own agent and hosted rooms for answers, the trust boundary both directions gate on, a way to send a request to a peer, and this side's own peer id. */
export interface AgentDetailsExchangeDeps {
  selfAgent: () => Readonly<Pick<AgentIdentity, "cwd" | "tags">> | undefined;
  hostedRooms: () => readonly Readonly<HostedRoomAdvert>[];
  isTrusted: (deviceHex: string) => boolean;
  requireTransport: () => Readonly<Pick<MeshTransport, "sendRoomRequest">>;
}

/** Both halves of agent-comms#323 in one place: the verb a trusted peer's request is answered by, and the background fetch that fills this side's cache from peers this machine trusts. */
export class AgentDetailsExchange {
  private readonly cache = new AgentDetailsCache();

  /** The registered verb handler, answering from this side's own agent and hosted rooms. */
  readonly handler: RoomVerbHandler;

  constructor(private readonly deps: Readonly<AgentDetailsExchangeDeps>) {
    this.handler = agentDetailsVerbHandler({
      details: () => {
        const agent = deps.selfAgent();
        return agent === undefined
          ? undefined
          : ownAgentDetailsOf(agent, deps.hostedRooms());
      },
      isTrusted: deps.isTrusted,
    });
  }

  /** Asks every trusted remote agent whose details a hub session withholds for them, without waiting: answers land in the cache and show on the next listing, and an unreachable peer simply keeps its not-shared listing. selfPeerId is the asking side's own agent, excluded from the fetches. */
  refresh(
    agents: readonly Readonly<AgentIdentity>[],
    selfPeerId: string,
  ): void {
    const shown = new Set<string>();
    for (const agent of agents) {
      shown.add(agent.id);
      if (agent.id === selfPeerId) continue;
      if (detailsShared(agent)) continue;
      if (!this.deps.isTrusted(agent.id)) continue;
      void this.fetch(agent.id);
    }
    this.cache.retain(shown);
  }

  /** The cached details for one remote agent, once its trusted peer has answered. */
  cached(agentId: string): Readonly<AgentDetails> | undefined {
    return this.cache.get(agentId);
  }

  /** One agent's fetch, retried while no route to it exists yet (a relay pairing takes a moment to come up) and settled by the first real answer either way. */
  private async fetch(agentId: string): Promise<void> {
    const deadline = Date.now() + JOIN_ROUTE_WAIT_MS;
    for (;;) {
      let outcome;
      try {
        outcome = await this.deps.requireTransport().sendRoomRequest(
          agentId,
          {
            verb: AGENT_DETAILS_CAPABILITY_VERB,
            params: { verb: AGENT_DETAILS_VERB },
          },
          { kind: "node" },
        );
      } catch {
        // An unreachable peer is routine (it is listed from its last advert); its details stay not shared.
        return;
      }
      const details = parseAgentDetails(outcome);
      if (details !== undefined) {
        this.cache.set(agentId, details);
        return;
      }
      // A pairing still warming answers "timeout" before it answers the verb, so that outcome is retried within the window too: the listing refreshes on every call, and a details fetch is never worth more than the wait.
      const transient =
        outcome.result === "error" &&
        (NO_ROUTE_CODES.has(outcome.code) || outcome.code === "timeout");
      if (!transient || Date.now() >= deadline) return;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, JOIN_ROUTE_RETRY_MS);
      });
    }
  }
}
