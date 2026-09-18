import { describe, expect, it } from "vitest";
import { meshContract } from "../contract.js";
import type { Action } from "../frontend/types.js";

/**
 * Every current Action variant (frontend/types.ts) must map onto exactly one contract procedure whose input schema accepts that variant's real shape (minus the `action` discriminant, which becomes the procedure name instead of a field). This is a fixture test, not a round-trip test -- it proves the contract is a complete, correctly-shaped superset of today's Action union before anything is wired to it.
 */
describe("meshContract", () => {
  const fixtures: Record<Action["action"], object> = {
    send: { target: "room-1", content: "hi" },
    dm: { target: "agent-1", content: "hi" },
    join_room: { room: "room-1" },
    leave_room: {},
    create_room: { name: "room-1", type: "public" },
    list_rooms: {},
    list_agents: {},
    read_room: {},
    destroy_room: { room: "room-1" },
    invite: { room: "room-1", agent: "agent-1" },
    decline_invite: { room: "room-1", reason: "busy" },
    kick: { room: "room-1", agent: "agent-1" },
    rename_agent: { agent: "agent-1", name: "new-name" },
  };

  const procedureNames: Record<Action["action"], keyof typeof meshContract> = {
    send: "send",
    dm: "dm",
    join_room: "joinRoom",
    leave_room: "leaveRoom",
    create_room: "createRoom",
    list_rooms: "listRooms",
    list_agents: "listAgents",
    read_room: "readRoom",
    destroy_room: "destroyRoom",
    invite: "invite",
    decline_invite: "declineInvite",
    kick: "kick",
    rename_agent: "renameAgent",
  };

  for (const [action, input] of Object.entries(fixtures)) {
    it(`maps "${action}" onto a contract procedure accepting its fields`, async () => {
      const procedureName = procedureNames[action as Action["action"]];
      const procedure = meshContract[procedureName];
      const inputSchema = procedure["~orpc"].inputSchemas?.[0];
      if (!inputSchema) throw new Error(`${procedureName} has no input schema`);
      const result = await inputSchema["~standard"].validate(input);
      expect(result.issues).toBeUndefined();
    });
  }

  it("has push_subscribe/push_unsubscribe as first-class typed procedures", () => {
    expect(meshContract.pushSubscribe).toBeDefined();
    expect(meshContract.pushUnsubscribe).toBeDefined();
  });

  it("has a single subscribeEvents procedure for the unified event stream", () => {
    expect(meshContract.subscribeEvents).toBeDefined();
  });
});
