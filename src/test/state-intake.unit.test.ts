/**
 * The state a peer sends is checked before a store takes any of it: an agent is described by its own store or the coordinator, a record sits under its own id with a name a registration would keep, and the size of a snapshot and of the agents a store keeps is bounded.
 */

import { describe, expect, it } from "vitest";
import {
  AgentSlots,
  MAX_KNOWN_AGENTS,
  MAX_NEW_AGENTS_PER_SOURCE,
  MAX_SNAPSHOT_ENTRIES,
  admitPatch,
  admitSnapshot,
} from "../core/state-intake.js";
import type { AgentIdentity, Room } from "../core/types.js";
import type { SerialisedState } from "../core/wire-protocol.js";

const DEVICE_ID_HEX_LENGTH = 64;
const SENDER = "a".repeat(DEVICE_ID_HEX_LENGTH);
const OTHER = "b".repeat(DEVICE_ID_HEX_LENGTH);
const SELF = "d".repeat(DEVICE_ID_HEX_LENGTH);
const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const OVER_CAP = 3;
const EVICTABLE = 5;
const OVERSIZE_COLLECTIONS = 4;
const COLLECTIONS_OVER_CAP = OVERSIZE_COLLECTIONS * OVER_CAP;

function agent(
  id: string,
  overrides: Partial<AgentIdentity> = {},
): AgentIdentity {
  return {
    id,
    version: 1,
    name: "worker",
    harness: "pi",
    cwd: "/tmp",
    pid: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    visibility: "visible",
    status: "active",
    tags: [],
    subscribedRooms: [],
    ...overrides,
  };
}

function roomOf(id: string): Room {
  return {
    id,
    version: 1,
    name: id,
    type: "public",
    owner: SENDER,
    createdAt: "2026-01-01T00:00:00.000Z",
    description: "",
    members: [],
    invited: [],
    memberJoins: {},
    memberLeaves: {},
    invitedJoins: {},
    invitedLeaves: {},
  };
}

function state(agents: readonly AgentIdentity[]): SerialisedState {
  return {
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
    rooms: {},
    messages: {},
    dms: {},
    deliveryQueues: {},
  };
}

const peer = { id: SENDER, isCoordinator: false };
const coordinator = { id: SENDER, isCoordinator: true };

/** A store holding `held`, with the claims one message from `sourceId` makes on it; `forgotten` lists what was evicted. */
function storeHolding(
  held: readonly AgentIdentity[],
  options: { sourceId?: string; connected?: readonly string[] } = {},
): {
  agents: Map<string, AgentIdentity>;
  slots: AgentSlots;
  forgotten: string[];
  claims: ReturnType<AgentSlots["open"]>;
} {
  const { sourceId = SENDER, connected = [] } = options;
  const agents = new Map(held.map((a) => [a.id, a]));
  const forgotten: string[] = [];
  const slots = new AgentSlots({
    agents,
    forget: (id) => {
      forgotten.push(id);
      agents.delete(id);
    },
    hasPeer: (id) => connected.includes(id),
    ownId: () => SELF,
    now: () => NOW,
  });
  return { agents, slots, forgotten, claims: slots.open(sourceId) };
}

function offline(id: string, startedAt: string): AgentIdentity {
  return agent(id, { status: "offline", startedAt });
}

function fullStore(
  extra: readonly AgentIdentity[] = [],
): readonly AgentIdentity[] {
  const filler = Array.from(
    { length: MAX_KNOWN_AGENTS - extra.length },
    (_, n) => agent(`active-${String(n)}`),
  );
  return [...filler, ...extra];
}

describe("a snapshot", () => {
  it("keeps the sender's own agent and refuses one that names another store, from a peer that is not the coordinator", () => {
    const { claims } = storeHolding([]);
    const { value, refused } = admitSnapshot(
      state([agent(SENDER), agent(OTHER)]),
      peer,
      SELF,
      claims,
    );

    expect(Object.keys(value.agents)).toEqual([SENDER]);
    expect(refused).toBe(1);
  });

  it("keeps the agents of other stores when the sender is the coordinator", () => {
    const { claims } = storeHolding([]);
    const { value, refused } = admitSnapshot(
      state([agent(SENDER), agent(OTHER)]),
      coordinator,
      SELF,
      claims,
    );

    expect(Object.keys(value.agents).sort()).toEqual([SENDER, OTHER].sort());
    expect(refused).toBe(0);
  });

  it("refuses a record that sits under another id than its own", () => {
    const forged = state([agent(SENDER)]);
    forged.agents[OTHER] = agent(SENDER);

    const { value, refused } = admitSnapshot(
      forged,
      coordinator,
      SELF,
      storeHolding([]).claims,
    );

    expect(Object.keys(value.agents)).toEqual([SENDER]);
    expect(refused).toBe(1);
  });

  it("refuses a record whose name a registration would not have kept as it is", () => {
    const { value, refused } = admitSnapshot(
      state([agent(SENDER, { name: "bad\u001b[2J" })]),
      peer,
      SELF,
      storeHolding([]).claims,
    );

    expect(value.agents).toEqual({});
    expect(refused).toBe(1);
  });

  it("cuts every collection to the most one snapshot may carry, and counts what it dropped", () => {
    const crowded = state([]);
    for (let n = 0; n < MAX_SNAPSHOT_ENTRIES + OVER_CAP; n++) {
      crowded.rooms[`room-${String(n)}`] = roomOf(`room-${String(n)}`);
      crowded.messages[`room-${String(n)}`] = [];
      crowded.dms[`dm-${String(n)}`] = [];
      crowded.deliveryQueues[`agent-${String(n)}`] = [];
    }

    const { value, refused } = admitSnapshot(
      crowded,
      peer,
      SELF,
      storeHolding([]).claims,
    );

    expect(Object.keys(value.rooms)).toHaveLength(MAX_SNAPSHOT_ENTRIES);
    expect(Object.keys(value.messages)).toHaveLength(MAX_SNAPSHOT_ENTRIES);
    expect(Object.keys(value.dms)).toHaveLength(MAX_SNAPSHOT_ENTRIES);
    expect(Object.keys(value.deliveryQueues)).toHaveLength(
      MAX_SNAPSHOT_ENTRIES,
    );
    expect(refused).toBe(COLLECTIONS_OVER_CAP);
  });

  it("takes an offline record of the receiver's own agent from anyone, so the store can contradict it, and refuses a running one", () => {
    const offlineOwn = admitSnapshot(
      state([agent(SELF, { status: "offline", version: 9 })]),
      peer,
      SELF,
      storeHolding([agent(SELF)]).claims,
    );
    expect(offlineOwn.value.agents[SELF]?.status).toBe("offline");
    expect(offlineOwn.refused).toBe(0);

    const running = admitSnapshot(
      state([agent(SELF, { status: "active", version: 9 })]),
      peer,
      SELF,
      storeHolding([agent(SELF)]).claims,
    );
    expect(running.value.agents).toEqual({});
    expect(running.refused).toBe(1);
  });

  it("takes no offline record of the receiver's own agent when the receiver holds none", () => {
    const { value } = admitSnapshot(
      state([agent(SELF, { status: "offline" })]),
      peer,
      SELF,
      storeHolding([]).claims,
    );
    expect(value.agents).toEqual({});
  });
});

describe("a store that holds the most agents it keeps", () => {
  it("evicts an offline record to take a new agent, and still updates one it knows", () => {
    const held = fullStore([offline("old", "2020-01-01T00:00:00.000Z")]);
    const { claims, forgotten, agents } = storeHolding(held);

    const { value, refused } = admitSnapshot(
      state([agent(SENDER)]),
      peer,
      SELF,
      claims,
    );

    expect(Object.keys(value.agents)).toEqual([SENDER]);
    expect(refused).toBe(0);
    expect(forgotten).toEqual(["old"]);
    expect(agents.has("old")).toBe(false);
  });

  it("refuses a new agent when nothing is offline, and takes an update of a known one", () => {
    const { claims, forgotten } = storeHolding(fullStore());

    const fresh = admitSnapshot(state([agent(SENDER)]), peer, SELF, claims);
    expect(fresh.value.agents).toEqual({});
    expect(fresh.refused).toBe(1);

    const known = admitSnapshot(
      state([agent("active-1")]),
      { id: "active-1", isCoordinator: false },
      SELF,
      storeHolding(fullStore()).claims,
    );
    expect(Object.keys(known.value.agents)).toEqual(["active-1"]);
    expect(forgotten).toEqual([]);
  });

  it("evicts a record with no peer before one with a peer, a start that is in the future or unreadable before an old one, then the oldest", () => {
    const held = fullStore([
      offline("connected-oldest", "2000-01-01T00:00:00.000Z"),
      offline("unconnected-recent", "2026-05-01T00:00:00.000Z"),
      offline("unconnected-oldest", "2001-01-01T00:00:00.000Z"),
      offline("unconnected-future", "2099-01-01T00:00:00.000Z"),
      offline("unconnected-unreadable", "not a time"),
    ]);
    const { slots, forgotten } = storeHolding(held, {
      connected: ["connected-oldest"],
    });
    const claims = slots.open(SENDER);

    for (let n = 0; n < EVICTABLE; n++) {
      claims.claim(`new-${String(n)}`);
    }

    expect(forgotten.slice(0, 2).sort()).toEqual([
      "unconnected-future",
      "unconnected-unreadable",
    ]);
    expect(forgotten.slice(2)).toEqual([
      "unconnected-oldest",
      "unconnected-recent",
      "connected-oldest",
    ]);
  });

  it("never evicts the store's own agent, or a record the same message just claimed", () => {
    const held = fullStore([offline(SELF, "2000-01-01T00:00:00.000Z")]);
    const { claims, forgotten } = storeHolding(held);

    expect(claims.claim("new-1")).toBe(false);
    expect(forgotten).toEqual([]);

    const room = storeHolding([
      ...fullStore().slice(1),
      offline("old", "2000-01-01T00:00:00.000Z"),
    ]);
    expect(room.claims.claim("first")).toBe(true);
    expect(room.claims.claim("second")).toBe(false);
  });
});

describe("what one connection introduces", () => {
  it("is bounded over its life, and starts again when the connection has ended", () => {
    const { slots } = storeHolding([]);
    for (let n = 0; n < MAX_NEW_AGENTS_PER_SOURCE; n++) {
      expect(slots.open(SENDER).claim(`a-${String(n)}`)).toBe(true);
    }
    expect(slots.open(SENDER).claim("one-too-many")).toBe(false);
    expect(slots.open(OTHER).claim("another-source")).toBe(true);

    slots.release(SENDER);
    expect(slots.open(SENDER).claim("again")).toBe(true);
  });
});

describe("a patch", () => {
  const roomPatch = { type: "room_delete", roomId: "r" } as const;

  it("takes an agent update from the agent's own store and from the coordinator, and from no one else", () => {
    const update = { type: "agent_upsert", agent: agent(OTHER) } as const;
    const take = (
      sender: Readonly<{ id: string; isCoordinator: boolean }>,
    ): boolean => admitPatch(update, sender, SELF, storeHolding([]).claims);

    expect(take({ id: OTHER, isCoordinator: false })).toBe(true);
    expect(take(coordinator)).toBe(true);
    expect(take(peer)).toBe(false);
  });

  it("takes an offline report under the same rule, and one about the receiver's own agent from anyone", () => {
    const take = (
      agentId: string,
      sender: Readonly<{ id: string; isCoordinator: boolean }>,
    ): boolean =>
      admitPatch(
        { type: "agent_offline", agentId },
        sender,
        SELF,
        storeHolding([]).claims,
      );

    expect(take(OTHER, peer)).toBe(false);
    expect(take(OTHER, coordinator)).toBe(true);
    expect(take(OTHER, { id: OTHER, isCoordinator: false })).toBe(true);
    expect(take(SELF, peer)).toBe(true);
  });

  it("refuses an update about the receiver's own agent from anyone but the coordinator", () => {
    expect(
      admitPatch(
        { type: "agent_upsert", agent: agent(SELF, { version: 99 }) },
        peer,
        SELF,
        storeHolding([agent(SELF)]).claims,
      ),
    ).toBe(false);
  });

  it("refuses an agent update whose name a registration would not have kept, and a new agent when the store is full of running ones", () => {
    expect(
      admitPatch(
        {
          type: "agent_upsert",
          agent: agent(SENDER, { name: "bad\u001b[2J" }),
        },
        peer,
        SELF,
        storeHolding([]).claims,
      ),
    ).toBe(false);
    expect(
      admitPatch(
        { type: "agent_upsert", agent: agent(SENDER) },
        peer,
        SELF,
        storeHolding(fullStore()).claims,
      ),
    ).toBe(false);
  });

  it("takes a patch about anything but an agent as it is", () => {
    expect(admitPatch(roomPatch, peer, SELF, storeHolding([]).claims)).toBe(
      true,
    );
  });
});
