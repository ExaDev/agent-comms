/**
 * The state a peer sends is checked before a store takes any of it: an agent is described by its own store or the coordinator, a record sits under its own id with a name a registration would keep, and the size of a snapshot and of the agents a store keeps is bounded.
 */

import { describe, expect, it } from "vitest";
import {
  AgentSlots,
  MAX_AGENTS_PER_SOURCE,
  MAX_KNOWN_AGENTS,
  MAX_SNAPSHOT_ENTRIES,
  admitPatch,
  admitSnapshot,
} from "../core/state-intake.js";
import { KnownAgents } from "../core/known-agents.js";
import type { AgentIdentity, Room } from "../core/types.js";
import type { SerialisedState } from "../core/wire-protocol.js";

const DEVICE_ID_HEX_LENGTH = 64;
const SENDER = "a".repeat(DEVICE_ID_HEX_LENGTH);
const OTHER = "b".repeat(DEVICE_ID_HEX_LENGTH);
const SELF = "d".repeat(DEVICE_ID_HEX_LENGTH);
const OVER_CAP = 3;
const EVICTABLE = 3;
const EVICTION_ORDER = 3;
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

/** A store holding `held`, which went offline in the order given, with the claims one message from `source` makes on it; `forgotten` lists what was evicted. */
function storeHolding(
  held: readonly AgentIdentity[],
  source = "conn-a",
): {
  agents: KnownAgents;
  slots: AgentSlots;
  forgotten: string[];
  claims: ReturnType<AgentSlots["open"]>;
} {
  const agents = new KnownAgents();
  for (const a of held) agents.set(a.id, a);
  const forgotten: string[] = [];
  const slots = new AgentSlots({
    agents,
    forget: (id) => {
      forgotten.push(id);
      agents.delete(id);
    },
    ownId: () => SELF,
  });
  return { agents, slots, forgotten, claims: slots.open(source) };
}

/** Claims a record for `id` and, as the store does once a claim is admitted, holds it. */
function take(
  held: ReturnType<typeof storeHolding>,
  id: string,
  status: AgentIdentity["status"] = "active",
): boolean {
  const taken = held.claims.claim(id);
  if (taken) held.agents.set(id, agent(id, { status }));
  return taken;
}

function offline(
  id: string,
  startedAt = "2026-01-01T00:00:00.000Z",
): AgentIdentity {
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
    const held = fullStore([offline("old")]);
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

  it("evicts the record that went offline longest ago, whatever its start time: a long-running agent that just went offline outlasts a short one that went offline long ago", () => {
    const held = storeHolding(
      fullStore([
        offline("went-offline-first", "2026-05-01T00:00:00.000Z"),
        offline("went-offline-second", "2001-01-01T00:00:00.000Z"),
        offline("went-offline-third", "2099-01-01T00:00:00.000Z"),
      ]),
    );

    for (let n = 0; n < EVICTABLE; n++) take(held, `new-${String(n)}`);

    expect(held.forgotten.slice(0, EVICTION_ORDER)).toEqual([
      "went-offline-first",
      "went-offline-second",
      "went-offline-third",
    ]);
  });

  it("counts the time a record went offline from the status change, and again from the next one after it came back", () => {
    const held = storeHolding(
      fullStore([offline("flapping"), offline("steady")]),
    );
    held.agents.set("flapping", agent("flapping"));
    held.agents.set("flapping", offline("flapping"));

    take(held, "new-1");

    expect(held.forgotten).toEqual(["steady"]);
  });

  it("takes an agent that comes back, with its record stored again, out of the records to evict, and one that goes offline in that way into them", () => {
    const held = storeHolding(
      fullStore([offline("comes-back"), agent("goes-offline")]),
    );
    const back = held.agents.get("comes-back");
    const out = held.agents.get("goes-offline");
    if (back === undefined || out === undefined) throw new Error("missing");
    back.status = "active";
    held.agents.set("comes-back", back);
    out.status = "offline";
    held.agents.set("goes-offline", out);

    take(held, "new-1");

    expect(held.forgotten).toEqual(["goes-offline"]);
  });

  it("never evicts a record whose status changed without being stored again, whatever the offline order says", () => {
    const held = storeHolding(fullStore([offline("stale-order")]));
    const stale = held.agents.get("stale-order");
    if (stale === undefined) throw new Error("missing");
    stale.status = "active";

    expect(take(held, "new-1")).toBe(false);
    expect(held.forgotten).toEqual([]);
  });

  it("keeps the time a record went offline while it is set offline again", () => {
    const held = storeHolding(fullStore([offline("first"), offline("second")]));
    held.agents.set("first", offline("first"));

    take(held, "new-1");

    expect(held.forgotten).toEqual(["first"]);
  });

  it("never evicts the store's own agent, or a record the same message just claimed", () => {
    const held = fullStore([offline(SELF)]);
    const { claims, forgotten } = storeHolding(held);

    expect(claims.claim("new-1")).toBe(false);
    expect(forgotten).toEqual([]);

    const room = storeHolding([...fullStore().slice(1), offline("old")]);
    expect(room.claims.claim("first")).toBe(true);
    expect(room.claims.claim("second")).toBe(false);
  });

  it("finds the record to evict without looking at every record held", () => {
    const held = storeHolding(fullStore([offline("old")]));
    const reads: string[] = [];
    const real = held.agents.offlineOldestFirst.bind(held.agents);
    held.agents.offlineOldestFirst = () => {
      const keys = real();
      return {
        [Symbol.iterator]() {
          return this;
        },
        next() {
          const step = keys.next();
          if (step.done !== true) reads.push(step.value);
          return step;
        },
      };
    };

    expect(take(held, "new-1")).toBe(true);
    expect(reads).toEqual(["old"]);
  });
});

describe("what one connection introduces", () => {
  it("is bounded by the agents of it that the store holds, and another connection is not affected", () => {
    const held = storeHolding([]);
    for (let n = 0; n < MAX_AGENTS_PER_SOURCE; n++) {
      expect(take(held, `a-${String(n)}`)).toBe(true);
    }
    expect(take(held, "one-too-many")).toBe(false);

    held.claims = held.slots.open("conn-b");
    expect(take(held, "another-connection")).toBe(true);
  });

  it("takes the place of the connection's own offline record at its bound, and never another connection's", () => {
    const held = storeHolding([]);
    held.claims = held.slots.open("conn-b");
    take(held, "b-offline", "offline");
    held.claims = held.slots.open("conn-a");
    take(held, "a-offline", "offline");
    for (let n = 1; n < MAX_AGENTS_PER_SOURCE; n++) {
      take(held, `a-${String(n)}`);
    }

    held.claims = held.slots.open("conn-a");
    expect(take(held, "a-new")).toBe(true);

    expect(held.forgotten).toEqual(["a-offline"]);
    expect(held.agents.has("b-offline")).toBe(true);
  });

  it("forgets the connection of an agent the store evicts or removes without waiting for that connection to be checked again", () => {
    const tracked = (slots: AgentSlots): number => {
      const bySource: unknown = Reflect.get(slots, "bySource");
      const sourceOf: unknown = Reflect.get(slots, "sourceOf");
      if (!(bySource instanceof Map) || !(sourceOf instanceof Map)) {
        throw new Error("the slots keep their bookkeeping elsewhere");
      }
      return bySource.size + sourceOf.size;
    };
    const deleted = storeHolding([]);
    take(deleted, "gone");
    expect(tracked(deleted.slots)).toBeGreaterThan(0);
    deleted.agents.delete("gone");
    expect(tracked(deleted.slots)).toBe(0);

    const cleared = storeHolding([]);
    take(cleared, "gone");
    cleared.agents.clear();
    expect(tracked(cleared.slots)).toBe(0);

    const evicted = storeHolding(fullStore([offline("old")]));
    take(evicted, "new-1");
    const sourceOf: unknown = Reflect.get(evicted.slots, "sourceOf");
    expect(sourceOf instanceof Map && sourceOf.has("old")).toBe(false);
  });

  it("stops counting an agent the store no longer holds", () => {
    const held = storeHolding([]);
    for (let n = 0; n < MAX_AGENTS_PER_SOURCE; n++)
      take(held, `a-${String(n)}`);
    held.agents.delete("a-0");

    held.claims = held.slots.open("conn-a");
    expect(take(held, "a-new")).toBe(true);
  });
});

describe("a patch", () => {
  const roomPatch = { type: "room_delete", roomId: "r" } as const;

  it("takes an agent update from the agent's own store and from the coordinator, and from no one else", () => {
    const update = { type: "agent_upsert", agent: agent(OTHER) } as const;
    const taken = (
      sender: Readonly<{ id: string; isCoordinator: boolean }>,
    ): boolean => admitPatch(update, sender, SELF, storeHolding([]).claims);

    expect(taken({ id: OTHER, isCoordinator: false })).toBe(true);
    expect(taken(coordinator)).toBe(true);
    expect(taken(peer)).toBe(false);
  });

  it("takes an offline report under the same rule, and one about the receiver's own agent from anyone", () => {
    const taken = (
      agentId: string,
      sender: Readonly<{ id: string; isCoordinator: boolean }>,
    ): boolean =>
      admitPatch(
        { type: "agent_offline", agentId },
        sender,
        SELF,
        storeHolding([]).claims,
      );

    expect(taken(OTHER, peer)).toBe(false);
    expect(taken(OTHER, coordinator)).toBe(true);
    expect(taken(OTHER, { id: OTHER, isCoordinator: false })).toBe(true);
    expect(taken(SELF, peer)).toBe(true);
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
