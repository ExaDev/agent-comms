/**
 * Direct, DI-based unit tests for what RoomProtocol reports about a directed room-domain request and what its retry queue does with one nobody answered: the outcome each caller is handed back, the delivery_status events a queued message's own sender is told about as it is held, dropped, expired, retried or refused, and the bounds that stop the queue growing without limit. See room-protocol.unit.test.ts and room-protocol-admission.unit.test.ts for the receiving side and the admission flow; all three share the harness in room-protocol.helper.ts.
 */
import { describe, expect, it } from "vitest";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import { saveRoomToken } from "../core/identity-store.js";
import { dmRoomPath, ownerNamedRoomPath } from "../core/room-path.js";
import {
  MAX_PENDING_ROOM_REQUESTS_PER_MEMBER,
  PENDING_ROOM_REQUEST_TTL_MS,
} from "../core/mesh-store-shared.js";
import { randomId } from "../core/random-id.js";
import { bytesToHex } from "wire-mesh-core/domain/device-id";
import type { DeliveryEvent } from "../core/types.js";
import {
  makeHarness,
  mintRoomToken,
  type Harness,
} from "./room-protocol.helper.js";

/** A token whose own bytes never matter here: the sending side attaches whatever this store persisted without inspecting it, and every assertion in this file is about the outcome the transport answers with, never about verification. */
const OPAQUE_TOKEN = "opaque" as unknown as CapabilityToken;

/** A well under the age bound, so a test that expects an entry to survive a sweep is not relying on the sweep never running. */
const WELL_WITHIN_TTL_MS = 1_000;

/** This harness's own canonical owner-named room path. Every real send names a room by its canonical path, and reporting a delivery status parses that path to tell a room message from a DM, so a test using a made-up path would be exercising something production never produces. */
function roomPath(h: Harness): string {
  return ownerNamedRoomPath(h.ids.ownerId, "general");
}

/** Persists a room:member token for roomPath, which flushPendingRoomRequests requires before it will retry anything queued against that path. */
async function persistToken(h: Harness, path: string): Promise<void> {
  saveRoomToken(
    { harness: "test", cwd: "room-protocol", dir: h.slotDir },
    path,
    await mintRoomToken(h.ids.ownerPort, h.ids.ownerId, path),
  );
}

/** A room.send's own params, carrying a real message-id so a delivery status can be reported against it. Returns both the params and the hex id the status events will name. */
function roomSendParams(): {
  params: Record<string, unknown>;
  messageId: string;
} {
  const messageId = randomId();
  return {
    params: { verb: "room.send", "message-id": messageId, text: "hi" },
    messageId: bytesToHex(messageId),
  };
}

/** Every delivery_status event this harness's delivery engine was asked to queue, in order. */
function deliveryStatuses(
  h: Harness,
): Extract<DeliveryEvent, { type: "delivery_status" }>[] {
  return h.queueDelivery.mock.calls
    .map((call): unknown => call[1])
    .filter(
      (event): event is Extract<DeliveryEvent, { type: "delivery_status" }> =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "delivery_status",
    );
}

describe("RoomProtocol — sendRoomRequestToMember outcomes", () => {
  it("reports a delivered request as delivered and queues nothing", async () => {
    const h = await makeHarness();
    await persistToken(h, roomPath(h));
    h.sendRoomRequest.mockResolvedValue({ result: "ok" });

    const outcome = await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      roomPath(h),
      OPAQUE_TOKEN,
      roomSendParams().params,
    );

    expect(outcome).toEqual({ kind: "delivered" });
    h.sendRoomRequest.mockClear();
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);
    expect(h.sendRoomRequest).not.toHaveBeenCalled();
  });

  it("reports a timed-out request as undelivered and holds it for retry", async () => {
    const h = await makeHarness();
    await persistToken(h, roomPath(h));
    h.sendRoomRequest.mockResolvedValue({ result: "error", code: "timeout" });
    const { params } = roomSendParams();

    const outcome = await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      roomPath(h),
      OPAQUE_TOKEN,
      params,
    );

    expect(outcome).toEqual({ kind: "undelivered", reason: "timeout" });
    h.sendRoomRequest.mockClear();
    h.sendRoomRequest.mockResolvedValue({ result: "ok" });
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);
    expect(h.sendRoomRequest).toHaveBeenCalledTimes(1);
  });

  it("reports a request the transport rejected outright as a lost connection", async () => {
    const h = await makeHarness();
    await persistToken(h, roomPath(h));
    h.sendRoomRequest.mockRejectedValue(new Error("connection dropped"));

    const outcome = await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      roomPath(h),
      OPAQUE_TOKEN,
      roomSendParams().params,
    );

    expect(outcome).toEqual({
      kind: "undelivered",
      reason: "connection_lost",
    });
  });

  it("reports a refusal without queuing it, since no retry can change the answer", async () => {
    const h = await makeHarness();
    await persistToken(h, roomPath(h));
    h.sendRoomRequest.mockResolvedValue({
      result: "error",
      code: "unauthorized",
    });

    const outcome = await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      roomPath(h),
      OPAQUE_TOKEN,
      roomSendParams().params,
    );

    expect(outcome).toEqual({ kind: "refused", code: "unauthorized" });
    h.sendRoomRequest.mockClear();
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);
    expect(h.sendRoomRequest).not.toHaveBeenCalled();
  });

  it("emits no delivery status for the send it just answered directly", async () => {
    const h = await makeHarness();
    await persistToken(h, roomPath(h));
    h.sendRoomRequest.mockResolvedValue({
      result: "error",
      code: "not_connected",
    });

    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      roomPath(h),
      OPAQUE_TOKEN,
      roomSendParams().params,
    );

    // The caller is already holding the queued outcome this call returned, so repeating it as an event would tell the one observer that matters something it has just been told. Delivery status events exist for what happens to a message afterwards, out of band of any call.
    expect(deliveryStatuses(h)).toEqual([]);
  });

  it("reports nothing for a request carrying no message of this sender's own", async () => {
    const h = await makeHarness();
    await persistToken(h, roomPath(h));
    h.sendRoomRequest.mockResolvedValue({ result: "error", code: "timeout" });

    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      roomPath(h),
      OPAQUE_TOKEN,
      {
        verb: "room.read",
        messages: [randomId()],
      },
    );
    h.sendRoomRequest.mockResolvedValue({ result: "ok" });
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);

    expect(deliveryStatuses(h)).toEqual([]);
  });
});

describe("RoomProtocol — retry queue delivery reporting", () => {
  it("tells the sender a queued message was delivered once the member is reachable", async () => {
    const h = await makeHarness();
    const dmPath = dmRoomPath(h.ids.ownerId, h.ids.memberId);
    await persistToken(h, dmPath);
    h.sendRoomRequest.mockResolvedValue({
      result: "error",
      code: "not_connected",
    });
    const { params, messageId } = roomSendParams();
    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      dmPath,
      OPAQUE_TOKEN,
      params,
    );

    h.sendRoomRequest.mockResolvedValue({ result: "ok" });
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);

    expect(deliveryStatuses(h)).toEqual([
      {
        type: "delivery_status",
        messageId,
        agent: h.ids.memberId,
        delivery: { status: "delivered" },
      },
    ]);
  });

  it("names the room for a room message and omits it for a DM", async () => {
    const h = await makeHarness();
    await persistToken(h, roomPath(h));
    h.sendRoomRequest.mockResolvedValue({ result: "error", code: "timeout" });
    const { params } = roomSendParams();
    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      roomPath(h),
      OPAQUE_TOKEN,
      params,
    );

    h.sendRoomRequest.mockResolvedValue({ result: "ok" });
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);

    expect(deliveryStatuses(h)[0]?.room).toBe(roomPath(h));
  });

  it("tells the sender a retried message was refused, and stops retrying it", async () => {
    const h = await makeHarness();
    const dmPath = dmRoomPath(h.ids.ownerId, h.ids.memberId);
    await persistToken(h, dmPath);
    h.sendRoomRequest.mockResolvedValue({ result: "error", code: "timeout" });
    const { params, messageId } = roomSendParams();
    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      dmPath,
      OPAQUE_TOKEN,
      params,
    );

    h.sendRoomRequest.mockResolvedValue({ result: "error", code: "denied" });
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);

    expect(deliveryStatuses(h)).toEqual([
      {
        type: "delivery_status",
        messageId,
        agent: h.ids.memberId,
        delivery: { status: "refused", code: "denied" },
      },
    ]);
    h.sendRoomRequest.mockClear();
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);
    expect(h.sendRoomRequest).not.toHaveBeenCalled();
  });

  it("holds a message whose retry also failed, without telling the sender anything new", async () => {
    const h = await makeHarness();
    await persistToken(h, roomPath(h));
    h.sendRoomRequest.mockResolvedValue({
      result: "error",
      code: "not_connected",
    });
    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      roomPath(h),
      OPAQUE_TOKEN,
      roomSendParams().params,
    );

    await h.protocol.flushPendingRoomRequests(h.ids.memberId);
    expect(deliveryStatuses(h)).toEqual([]);

    h.sendRoomRequest.mockResolvedValue({ result: "ok" });
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);
    expect(deliveryStatuses(h).map((event) => event.delivery.status)).toEqual([
      "delivered",
    ]);
  });

  it("drops a queued message this store no longer holds a room token for", async () => {
    const h = await makeHarness();
    h.sendRoomRequest.mockResolvedValue({ result: "error", code: "timeout" });
    const { params, messageId } = roomSendParams();
    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      roomPath(h),
      OPAQUE_TOKEN,
      params,
    );

    h.sendRoomRequest.mockClear();
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);

    expect(h.sendRoomRequest).not.toHaveBeenCalled();
    expect(deliveryStatuses(h)).toEqual([
      {
        type: "delivery_status",
        messageId,
        agent: h.ids.memberId,
        delivery: { status: "dropped" },
        room: roomPath(h),
      },
    ]);
  });
});

describe("RoomProtocol — retry queue bounds", () => {
  it("drops the oldest queued message beyond the per-member bound and says so", async () => {
    const h = await makeHarness();
    await persistToken(h, roomPath(h));
    h.sendRoomRequest.mockResolvedValue({ result: "error", code: "timeout" });

    const first = roomSendParams();
    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      roomPath(h),
      OPAQUE_TOKEN,
      first.params,
    );
    for (let i = 0; i < MAX_PENDING_ROOM_REQUESTS_PER_MEMBER; i++) {
      await h.protocol.sendRoomRequestToMember(
        h.ids.memberId,
        roomPath(h),
        OPAQUE_TOKEN,
        roomSendParams().params,
      );
    }

    expect(deliveryStatuses(h)).toEqual([
      {
        type: "delivery_status",
        messageId: first.messageId,
        agent: h.ids.memberId,
        delivery: { status: "dropped" },
        room: roomPath(h),
      },
    ]);

    h.sendRoomRequest.mockClear();
    h.sendRoomRequest.mockResolvedValue({ result: "ok" });
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);
    expect(h.sendRoomRequest).toHaveBeenCalledTimes(
      MAX_PENDING_ROOM_REQUESTS_PER_MEMBER,
    );
  });

  it("gives up on a queued message older than the age bound and tells the sender it expired", async () => {
    const h = await makeHarness();
    await persistToken(h, roomPath(h));
    h.sendRoomRequest.mockResolvedValue({ result: "error", code: "timeout" });
    const stale = roomSendParams();
    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      roomPath(h),
      OPAQUE_TOKEN,
      stale.params,
    );

    h.advanceClock(PENDING_ROOM_REQUEST_TTL_MS + WELL_WITHIN_TTL_MS);
    h.sendRoomRequest.mockClear();
    h.sendRoomRequest.mockResolvedValue({ result: "ok" });
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);

    expect(h.sendRoomRequest).not.toHaveBeenCalled();
    expect(deliveryStatuses(h)).toEqual([
      {
        type: "delivery_status",
        messageId: stale.messageId,
        agent: h.ids.memberId,
        delivery: { status: "expired" },
        room: roomPath(h),
      },
    ]);
  });

  it("keeps a message that has not reached the age bound", async () => {
    const h = await makeHarness();
    await persistToken(h, roomPath(h));
    h.sendRoomRequest.mockResolvedValue({ result: "error", code: "timeout" });
    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      roomPath(h),
      OPAQUE_TOKEN,
      roomSendParams().params,
    );

    h.advanceClock(PENDING_ROOM_REQUEST_TTL_MS - WELL_WITHIN_TTL_MS);
    h.sendRoomRequest.mockClear();
    h.sendRoomRequest.mockResolvedValue({ result: "ok" });
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);

    expect(h.sendRoomRequest).toHaveBeenCalledTimes(1);
    expect(deliveryStatuses(h).map((event) => event.delivery.status)).toEqual([
      "delivered",
    ]);
  });

  it("does not let a failed retry refresh a message's age", async () => {
    const h = await makeHarness();
    await persistToken(h, roomPath(h));
    h.sendRoomRequest.mockResolvedValue({ result: "error", code: "timeout" });
    await h.protocol.sendRoomRequestToMember(
      h.ids.memberId,
      roomPath(h),
      OPAQUE_TOKEN,
      roomSendParams().params,
    );

    // A member that keeps briefly reappearing and failing must not be able to keep a message pending forever, so each failed retry re-queues it with the age it already had.
    const halfTtl = PENDING_ROOM_REQUEST_TTL_MS / 2;
    h.advanceClock(halfTtl);
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);
    h.advanceClock(halfTtl + WELL_WITHIN_TTL_MS);
    h.sendRoomRequest.mockClear();
    await h.protocol.flushPendingRoomRequests(h.ids.memberId);

    expect(h.sendRoomRequest).not.toHaveBeenCalled();
    expect(deliveryStatuses(h).map((event) => event.delivery.status)).toEqual([
      "expired",
    ]);
  });
});
