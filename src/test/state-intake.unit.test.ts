/**
 * The state a peer sends is checked before a store takes any of it: an agent is described by its own store or the coordinator, a record sits under its own id with a name a registration would keep, and the size of a snapshot and of the agents a store keeps is bounded.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_KNOWN_AGENTS,
  MAX_SNAPSHOT_ENTRIES,
  admitPatch,
  admitSnapshot,
} from "../core/state-intake.js";
import type { AgentIdentity, Room } from "../core/types.js";
import type { SerialisedState } from "../core/wire-protocol.js";

const DEVICE_ID_HEX_LENGTH = 64;
const SENDER = "a".repeat(DEVICE_ID_HEX_LENGTH);
const OTHER = "b".repeat(DEVICE_ID_HEX_LENGTH);
const OVER_CAP = 3;
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

function room(id: string): Room {
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

describe("a snapshot", () => {
  it("keeps the sender's own agent and refuses one that names another store, from a peer that is not the coordinator", () => {
    const { value, refused } = admitSnapshot(
      state([agent(SENDER), agent(OTHER)]),
      peer,
      new Map(),
    );

    expect(Object.keys(value.agents)).toEqual([SENDER]);
    expect(refused).toBe(1);
  });

  it("keeps the agents of other stores when the sender is the coordinator", () => {
    const { value, refused } = admitSnapshot(
      state([agent(SENDER), agent(OTHER)]),
      coordinator,
      new Map(),
    );

    expect(Object.keys(value.agents).sort()).toEqual([SENDER, OTHER].sort());
    expect(refused).toBe(0);
  });

  it("refuses a record that sits under another id than its own", () => {
    const forged = state([agent(SENDER)]);
    forged.agents[OTHER] = agent(SENDER);

    const { value, refused } = admitSnapshot(forged, coordinator, new Map());

    expect(Object.keys(value.agents)).toEqual([SENDER]);
    expect(refused).toBe(1);
  });

  it("refuses a record whose name a registration would not have kept as it is", () => {
    const { value, refused } = admitSnapshot(
      state([agent(SENDER, { name: "bad\u001b[2J" })]),
      peer,
      new Map(),
    );

    expect(value.agents).toEqual({});
    expect(refused).toBe(1);
  });

  it("cuts every collection to the most one snapshot may carry, and counts what it dropped", () => {
    const many = MAX_SNAPSHOT_ENTRIES + OVER_CAP;
    const crowded = state([]);
    for (let n = 0; n < many; n++) {
      crowded.rooms[`room-${String(n)}`] = room(`room-${String(n)}`);
      crowded.messages[`room-${String(n)}`] = [];
      crowded.dms[`dm-${String(n)}`] = [];
      crowded.deliveryQueues[`agent-${String(n)}`] = [];
    }

    const { value, refused } = admitSnapshot(crowded, peer, new Map());

    expect(Object.keys(value.rooms)).toHaveLength(MAX_SNAPSHOT_ENTRIES);
    expect(Object.keys(value.messages)).toHaveLength(MAX_SNAPSHOT_ENTRIES);
    expect(Object.keys(value.dms)).toHaveLength(MAX_SNAPSHOT_ENTRIES);
    expect(Object.keys(value.deliveryQueues)).toHaveLength(
      MAX_SNAPSHOT_ENTRIES,
    );
    expect(refused).toBe(COLLECTIONS_OVER_CAP);
  });

  it("refuses a new agent once the store holds the most it keeps, and still updates one it already knows", () => {
    const known = new Map<string, unknown>();
    for (let n = 0; n < MAX_KNOWN_AGENTS - 1; n++)
      known.set(`k${String(n)}`, 1);
    known.set(SENDER, 1);
    const sentByCoordinator = state([agent(SENDER), agent(OTHER)]);

    const { value, refused } = admitSnapshot(
      sentByCoordinator,
      coordinator,
      known,
    );

    expect(Object.keys(value.agents)).toEqual([SENDER]);
    expect(refused).toBe(1);
  });
});

describe("a patch", () => {
  const roomPatch = { type: "room_delete", roomId: "r" } as const;

  it("takes an agent update from the agent's own store and from the coordinator, and from no one else", () => {
    const update = { type: "agent_upsert", agent: agent(OTHER) } as const;

    expect(
      admitPatch(update, { id: OTHER, isCoordinator: false }, new Map()),
    ).toBe(true);
    expect(admitPatch(update, coordinator, new Map())).toBe(true);
    expect(admitPatch(update, peer, new Map())).toBe(false);
  });

  it("takes an offline report under the same rule", () => {
    const offline = { type: "agent_offline", agentId: OTHER } as const;

    expect(admitPatch(offline, peer, new Map())).toBe(false);
    expect(admitPatch(offline, coordinator, new Map())).toBe(true);
    expect(
      admitPatch(offline, { id: OTHER, isCoordinator: false }, new Map()),
    ).toBe(true);
  });

  it("refuses an agent update whose name a registration would not have kept, and a new agent past the most a store keeps", () => {
    const known = new Map<string, unknown>();
    for (let n = 0; n < MAX_KNOWN_AGENTS; n++) known.set(`k${String(n)}`, 1);

    expect(
      admitPatch(
        {
          type: "agent_upsert",
          agent: agent(SENDER, { name: "bad\u001b[2J" }),
        },
        peer,
        new Map(),
      ),
    ).toBe(false);
    expect(
      admitPatch({ type: "agent_upsert", agent: agent(SENDER) }, peer, known),
    ).toBe(false);
  });

  it("takes a patch about anything but an agent as it is", () => {
    expect(admitPatch(roomPatch, peer, new Map())).toBe(true);
  });
});
