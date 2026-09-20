/**
 * Direct, DI-based unit tests for RoomProtocol -- the receiving/responding half of the room wire protocol, split across two files to stay under this repo's max-lines cap: this file covers handleRoomSend, handleRoomRead, handleRoomMembers, and sendRoomMessageDirected. See room-protocol-admission.test.ts for sendRoomRequestToMember/flushPendingRoomRequests, handleRoomJoin/admitRoomJoin, acceptRoomJoin/rejectRoomJoin, handleRoomInvite, and handleRoomLeave, and its own copy of this file's header comment for the full rationale (real identities/tokens, not opaque placeholders, since this side genuinely verifies tokens cryptographically).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToHex, deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { createSystemClock } from "wire-mesh-core/adapters/system-clock";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import type { ManageOutcome } from "wire-mesh-core/domain/mesh-session";
import { loadRoomTokens, saveRoomToken } from "../core/identity-store.js";
import { dmRoomPath, ownerNamedRoomPath } from "../core/room-path.js";
import { MAX_PENDING_ROOM_REQUESTS_PER_MEMBER } from "../core/mesh-store-shared.js";
import {
  DEVICE_ID_HEX_LENGTH,
  JOIN_DECISION_TIMEOUT_MS,
  SAMPLE_MESSAGE_ID,
  SAMPLE_REF_ID,
  SAMPLE_TOKEN_ID,
  UNRECOGNISED_MESSAGE_ID,
  agent,
  handle,
  makeHarness,
  manageRequest,
  mintRoomToken,
  room,
  type Harness,
} from "./room-protocol.helper.js";

describe("RoomProtocol — handleRoomSend", () => {
  let h: Harness;
  let ownerNamedRoom: string;

  beforeEach(async () => {
    h = await makeHarness();
    ownerNamedRoom = ownerNamedRoomPath(h.ids.ownerId, "general");
    h.deps.rooms.set(
      ownerNamedRoom,
      room({
        id: ownerNamedRoom,
        owner: h.ids.ownerId,
        members: [h.ids.ownerId, h.ids.memberId],
      }),
    );
  });

  async function send(
    params: Record<string, unknown>,
    token: CapabilityToken | undefined,
  ): Promise<ManageOutcome> {
    const handler = h.protocol.roomVerbHandlers["room.send"];
    if (handler === undefined) throw new Error("expected room.send handler");
    return handler(
      manageRequest({
        scope: { kind: "room", path: ownerNamedRoom },
        token,
        params,
      }),
      handle(h.ids.memberId),
    );
  }

  it("returns missing_scope_path when the request carries no room path", async () => {
    const handler = h.protocol.roomVerbHandlers["room.send"];
    if (handler === undefined) throw new Error("expected room.send handler");
    const outcome = await handler(
      manageRequest({ scope: { kind: "room" } }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "error", code: "missing_scope_path" });
  });

  it("returns unauthorized when no token is presented", async () => {
    const outcome = await send({}, undefined);
    expect(outcome).toEqual({ result: "error", code: "unauthorized" });
  });

  it("returns unauthorized for a token that fails verification (wrong bearer)", async () => {
    const wrongBearerToken = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.ownerId,
      ownerNamedRoom,
    );
    const outcome = await send({}, wrongBearerToken);
    expect(outcome).toEqual({ result: "error", code: "unauthorized" });
  });

  it("returns malformed_params for params that don't satisfy the room.send schema", async () => {
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const outcome = await send({ verb: "room.send" }, token);
    expect(outcome).toEqual({ result: "error", code: "malformed_params" });
  });

  it("stores the message in this room's own history and returns ok", async () => {
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const outcome = await send(
      {
        verb: "room.send",
        "message-id": SAMPLE_MESSAGE_ID,
        "sent-at": Date.now(),
        text: "hi there",
      },
      token,
    );
    expect(outcome).toEqual({ result: "ok" });
    const history = h.deps.messages.get(ownerNamedRoom);
    expect(history).toHaveLength(1);
    expect(history?.[0]?.content).toBe("hi there");
    expect(history?.[0]?.from).toBe(h.ids.memberId);
    expect(history?.[0]?.readBy).toEqual([h.ids.memberId]);
  });

  it('includes replyTo only when a refs entry has relation "reply"', async () => {
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );

    await send(
      {
        verb: "room.send",
        "message-id": SAMPLE_MESSAGE_ID,
        "sent-at": Date.now(),
        text: "reply",
        refs: [
          { id: SAMPLE_REF_ID, relation: "forward" },
          { id: SAMPLE_REF_ID, relation: "reply" },
        ],
      },
      token,
    );
    const stored = h.deps.messages.get(ownerNamedRoom)?.[0];
    expect(stored?.replyTo).toBe(Buffer.from(SAMPLE_REF_ID).toString("hex"));
  });

  it('omits replyTo when no refs entry has relation "reply"', async () => {
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    await send(
      {
        verb: "room.send",
        "message-id": SAMPLE_MESSAGE_ID,
        "sent-at": Date.now(),
        text: "no reply",
        refs: [{ id: SAMPLE_REF_ID, relation: "forward" }],
      },
      token,
    );
    const stored = h.deps.messages.get(ownerNamedRoom)?.[0];
    expect(stored).not.toHaveProperty("replyTo");
  });

  it("includes streamingBehavior only when a valid value is present", async () => {
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    await send(
      {
        verb: "room.send",
        "message-id": SAMPLE_MESSAGE_ID,
        "sent-at": Date.now(),
        text: "steer",
        "streaming-behavior": "steer",
      },
      token,
    );
    const stored = h.deps.messages.get(ownerNamedRoom)?.[0];
    expect(stored?.streamingBehavior).toBe("steer");
  });

  it("drops an unrecognised streamingBehavior value rather than rejecting the whole send", async () => {
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const outcome = await send(
      {
        verb: "room.send",
        "message-id": SAMPLE_MESSAGE_ID,
        "sent-at": Date.now(),
        text: "bad behavior",
        "streaming-behavior": "not-a-real-behavior",
      },
      token,
    );
    expect(outcome).toEqual({ result: "ok" });
    const stored = h.deps.messages.get(ownerNamedRoom)?.[0];
    expect(stored).not.toHaveProperty("streamingBehavior");
  });

  it("delivers the message locally and queues it, for the owner's own peer id", async () => {
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    await send(
      {
        verb: "room.send",
        "message-id": SAMPLE_MESSAGE_ID,
        "sent-at": Date.now(),
        text: "hi",
      },
      token,
    );
    expect(h.queueDelivery).toHaveBeenCalledWith(
      h.ids.ownerId,
      expect.objectContaining({ type: "room_message" }),
    );
    expect(h.fireLocalDelivery).toHaveBeenCalledWith(
      h.ids.ownerId,
      expect.objectContaining({ type: "room_message" }),
    );
  });

  it("stores a DM-path send as a DmMessage keyed by the dm path, self-issued and bearer as the sender", async () => {
    const h2 = await makeHarness();
    const dmPath = dmRoomPath(h2.ids.ownerId, h2.ids.memberId);
    // Obligation 1 for a DM: the chain root must be the verifying identity itself.
    const token = await mintRoomToken(
      h2.ids.ownerPort,
      h2.ids.memberId,
      dmPath,
    );
    const handler = h2.protocol.roomVerbHandlers["room.send"];
    if (handler === undefined) throw new Error("expected room.send handler");

    const outcome = await handler(
      manageRequest({
        scope: { kind: "room", path: dmPath },
        token,
        params: {
          verb: "room.send",
          "message-id": SAMPLE_MESSAGE_ID,
          "sent-at": Date.now(),
          text: "dm hello",
        },
      }),
      handle(h2.ids.memberId),
    );

    expect(outcome).toEqual({ result: "ok" });
    const dmHistory = h2.deps.dms.get(dmPath);
    expect(dmHistory).toHaveLength(1);
    expect(dmHistory?.[0]?.to).toBe(h2.ids.ownerId);
    expect(dmHistory?.[0]?.from).toBe(h2.ids.memberId);
    expect(h2.deps.messages.has(dmPath)).toBe(false);
  });

  it("includes streamingBehavior on a DM-path send only when a valid value is present", async () => {
    const h2 = await makeHarness();
    const dmPath = dmRoomPath(h2.ids.ownerId, h2.ids.memberId);
    const token = await mintRoomToken(
      h2.ids.ownerPort,
      h2.ids.memberId,
      dmPath,
    );
    const handler = h2.protocol.roomVerbHandlers["room.send"];
    if (handler === undefined) throw new Error("expected room.send handler");

    await handler(
      manageRequest({
        scope: { kind: "room", path: dmPath },
        token,
        params: {
          verb: "room.send",
          "message-id": SAMPLE_MESSAGE_ID,
          "sent-at": Date.now(),
          text: "dm steer",
          "streaming-behavior": "steer",
        },
      }),
      handle(h2.ids.memberId),
    );
    expect(h2.deps.dms.get(dmPath)?.[0]?.streamingBehavior).toBe("steer");

    const h3 = await makeHarness();
    const dmPath2 = dmRoomPath(h3.ids.ownerId, h3.ids.memberId);
    const token2 = await mintRoomToken(
      h3.ids.ownerPort,
      h3.ids.memberId,
      dmPath2,
    );
    const handler2 = h3.protocol.roomVerbHandlers["room.send"];
    if (handler2 === undefined) throw new Error("expected room.send handler");
    await handler2(
      manageRequest({
        scope: { kind: "room", path: dmPath2 },
        token: token2,
        params: {
          verb: "room.send",
          "message-id": SAMPLE_MESSAGE_ID,
          "sent-at": Date.now(),
          text: "dm no behavior",
        },
      }),
      handle(h3.ids.memberId),
    );
    expect(h3.deps.dms.get(dmPath2)?.[0]).not.toHaveProperty(
      "streamingBehavior",
    );
  });
});

describe("RoomProtocol — handleRoomRead", () => {
  let h: Harness;
  let ownerNamedRoom: string;

  beforeEach(async () => {
    h = await makeHarness();
    ownerNamedRoom = ownerNamedRoomPath(h.ids.ownerId, "general");
    h.deps.rooms.set(
      ownerNamedRoom,
      room({
        id: ownerNamedRoom,
        owner: h.ids.ownerId,
        members: [h.ids.ownerId, h.ids.memberId],
      }),
    );
  });

  async function read(
    params: Record<string, unknown>,
    token: CapabilityToken | undefined,
  ): Promise<ManageOutcome> {
    const handlerFn = h.protocol.roomVerbHandlers["room.read"];
    if (handlerFn === undefined) throw new Error("expected room.read handler");
    return handlerFn(
      manageRequest({
        scope: { kind: "room", path: ownerNamedRoom },
        token,
        params,
      }),
      handle(h.ids.memberId),
    );
  }

  it("returns missing_scope_path when the request carries no room path", async () => {
    const handlerFn = h.protocol.roomVerbHandlers["room.read"];
    if (handlerFn === undefined) throw new Error("expected room.read handler");
    const outcome = await handlerFn(
      manageRequest({ scope: { kind: "room" } }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "error", code: "missing_scope_path" });
  });

  it("returns unauthorized when no token is presented", async () => {
    expect(await read({}, undefined)).toEqual({
      result: "error",
      code: "unauthorized",
    });
  });

  it("returns unauthorized for a token that fails verification", async () => {
    const wrongBearerToken = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.ownerId,
      ownerNamedRoom,
    );
    expect(await read({}, wrongBearerToken)).toEqual({
      result: "error",
      code: "unauthorized",
    });
  });

  it("returns malformed_params for params that don't satisfy the room.read schema", async () => {
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    expect(await read({ verb: "room.read" }, token)).toEqual({
      result: "error",
      code: "malformed_params",
    });
  });

  it("silently skips a message-id this store doesn't recognise, rather than erroring", async () => {
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const outcome = await read(
      {
        verb: "room.read",
        messages: [UNRECOGNISED_MESSAGE_ID],
        at: Date.now(),
      },
      token,
    );
    expect(outcome).toEqual({ result: "ok" });
    expect(h.queueDelivery).not.toHaveBeenCalled();
  });

  it("marks a recognised message read and fires a delivery_status event, only once even if already read", async () => {
    const messageId = "aa";
    h.deps.messages.set(ownerNamedRoom, [
      {
        id: messageId,
        from: h.ids.ownerId,
        room: ownerNamedRoom,
        content: "hi",
        timestamp: "2026-01-01T00:00:00.000Z",
        readBy: [h.ids.ownerId],
      },
    ]);
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );

    await read(
      {
        verb: "room.read",
        messages: [Buffer.from(messageId, "hex")],
        at: Date.now(),
      },
      token,
    );

    const stored = h.deps.messages.get(ownerNamedRoom)?.[0];
    expect(stored?.readBy).toEqual([h.ids.ownerId, h.ids.memberId]);
    expect(h.queueDelivery).toHaveBeenCalledWith(
      h.ids.ownerId,
      expect.objectContaining({
        type: "delivery_status",
        room: ownerNamedRoom,
      }),
    );

    // Reading it again must not duplicate the readBy entry.
    h.queueDelivery.mockClear();
    await read(
      {
        verb: "room.read",
        messages: [Buffer.from(messageId, "hex")],
        at: Date.now(),
      },
      token,
    );
    expect(stored?.readBy).toEqual([h.ids.ownerId, h.ids.memberId]);
  });

  it("reads against the dm history, not the room history, for a dm path, and omits room from the event", async () => {
    const h2 = await makeHarness();
    const dmPath = dmRoomPath(h2.ids.ownerId, h2.ids.memberId);
    const messageId = "bb";
    h2.deps.dms.set(dmPath, [
      {
        id: messageId,
        from: h2.ids.ownerId,
        to: h2.ids.memberId,
        content: "hi",
        timestamp: "2026-01-01T00:00:00.000Z",
        readBy: [],
      },
    ]);
    const token = await mintRoomToken(
      h2.ids.ownerPort,
      h2.ids.memberId,
      dmPath,
    );
    const handlerFn = h2.protocol.roomVerbHandlers["room.read"];
    if (handlerFn === undefined) throw new Error("expected room.read handler");

    await handlerFn(
      manageRequest({
        scope: { kind: "room", path: dmPath },
        token,
        params: {
          verb: "room.read",
          messages: [Buffer.from(messageId, "hex")],
          at: Date.now(),
        },
      }),
      handle(h2.ids.memberId),
    );

    expect(h2.deps.dms.get(dmPath)?.[0]?.readBy).toEqual([h2.ids.memberId]);
    const call = h2.queueDelivery.mock.calls[0];
    expect(call?.[1]).not.toHaveProperty("room");
  });
});

describe("RoomProtocol — handleRoomMembers", () => {
  let h: Harness;
  let ownerNamedRoom: string;

  beforeEach(async () => {
    h = await makeHarness();
    ownerNamedRoom = ownerNamedRoomPath(h.ids.ownerId, "general");
  });

  it("returns missing_scope_path when the request carries no room path", async () => {
    const handlerFn = h.protocol.roomVerbHandlers["room.members"];
    if (handlerFn === undefined)
      throw new Error("expected room.members handler");
    const outcome = await handlerFn(
      manageRequest({ scope: { kind: "room" } }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "error", code: "missing_scope_path" });
  });

  it("returns unauthorized when no token is presented", async () => {
    const handlerFn = h.protocol.roomVerbHandlers["room.members"];
    if (handlerFn === undefined)
      throw new Error("expected room.members handler");
    const outcome = await handlerFn(
      manageRequest({ scope: { kind: "room", path: ownerNamedRoom } }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "error", code: "unauthorized" });
  });

  it("returns unauthorized for a token that fails verification", async () => {
    const wrongBearerToken = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.ownerId,
      ownerNamedRoom,
    );
    const handlerFn = h.protocol.roomVerbHandlers["room.members"];
    if (handlerFn === undefined)
      throw new Error("expected room.members handler");
    const outcome = await handlerFn(
      manageRequest({
        scope: { kind: "room", path: ownerNamedRoom },
        token: wrongBearerToken,
      }),
      handle(h.ids.memberId),
    );
    expect(outcome).toEqual({ result: "error", code: "unauthorized" });
  });

  it("returns an empty members list for a room this store has no local record of", async () => {
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const handlerFn = h.protocol.roomVerbHandlers["room.members"];
    if (handlerFn === undefined)
      throw new Error("expected room.members handler");
    const outcome = await handlerFn(
      manageRequest({ scope: { kind: "room", path: ownerNamedRoom }, token }),
      handle(h.ids.memberId),
    );
    expect(outcome).toMatchObject({ result: "ok", members: [] });
  });

  it("maps a named room's real member list to device objects", async () => {
    h.deps.rooms.set(
      ownerNamedRoom,
      room({
        id: ownerNamedRoom,
        owner: h.ids.ownerId,
        members: [h.ids.ownerId, h.ids.memberId],
      }),
    );
    const token = await mintRoomToken(
      h.ids.ownerPort,
      h.ids.memberId,
      ownerNamedRoom,
    );
    const handlerFn = h.protocol.roomVerbHandlers["room.members"];
    if (handlerFn === undefined)
      throw new Error("expected room.members handler");
    const outcome = await handlerFn(
      manageRequest({ scope: { kind: "room", path: ownerNamedRoom }, token }),
      handle(h.ids.memberId),
    );
    expect(outcome).toMatchObject({
      result: "ok",
      members: [
        { device: deviceIdFromHex(h.ids.ownerId) },
        { device: deviceIdFromHex(h.ids.memberId) },
      ],
    });
  });

  it("derives a dm path's members directly from its own two participants, with no Room record", async () => {
    const h2 = await makeHarness();
    const dmPath = dmRoomPath(h2.ids.ownerId, h2.ids.memberId);
    const token = await mintRoomToken(
      h2.ids.ownerPort,
      h2.ids.memberId,
      dmPath,
    );
    const handlerFn = h2.protocol.roomVerbHandlers["room.members"];
    if (handlerFn === undefined)
      throw new Error("expected room.members handler");
    const outcome = await handlerFn(
      manageRequest({ scope: { kind: "room", path: dmPath }, token }),
      handle(h2.ids.memberId),
    );
    // dmRoomPath sorts its two participants lexicographically, so the resulting member order isn't [owner, member] -- it's whichever hex string sorts first.
    const [first, second] =
      h2.ids.ownerId < h2.ids.memberId
        ? [h2.ids.ownerId, h2.ids.memberId]
        : [h2.ids.memberId, h2.ids.ownerId];
    expect(outcome).toMatchObject({
      result: "ok",
      members: [
        { device: deviceIdFromHex(first) },
        { device: deviceIdFromHex(second) },
      ],
    });
  });
});

describe("RoomProtocol — sendRoomMessageDirected", () => {
  it("throws NOT_A_MEMBER naming the exact room path when no token is persisted for it", async () => {
    const h = await makeHarness();
    await expect(
      h.protocol.sendRoomMessageDirected("no-token-room", h.ids.memberId, "hi"),
    ).rejects.toMatchObject({
      message: "No room:member token for no-token-room",
      code: "NOT_A_MEMBER",
    });
  });

  it("throws SEND_FAILED naming the member, room, and failure code when the transport reports a non-ok outcome", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.ownerId, "general");
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(
      { harness: "test", cwd: "room-protocol", dir: h.slotDir },
      roomPath,
      token,
    );
    h.sendRoomRequest.mockResolvedValue({
      result: "error",
      code: "not_connected",
    });

    await expect(
      h.protocol.sendRoomMessageDirected(roomPath, h.ids.memberId, "hi"),
    ).rejects.toMatchObject({
      message: `room.send to ${h.ids.memberId} for ${roomPath} failed (not_connected)`,
      code: "SEND_FAILED",
    });
  });

  it("succeeds and sends via the transport with the persisted token when one exists", async () => {
    const h = await makeHarness();
    const roomPath = ownerNamedRoomPath(h.ids.ownerId, "general");
    const token = await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, roomPath);
    saveRoomToken(
      { harness: "test", cwd: "room-protocol", dir: h.slotDir },
      roomPath,
      token,
    );

    await h.protocol.sendRoomMessageDirected(roomPath, h.ids.memberId, "hi");

    expect(h.sendRoomRequest).toHaveBeenCalledTimes(1);
    const call = h.sendRoomRequest.mock.calls[0];
    expect(call?.[0]).toBe(h.ids.memberId);
    expect(call?.[2]).toEqual({ kind: "room", path: roomPath });
  });
});
