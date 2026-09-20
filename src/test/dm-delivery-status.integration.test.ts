/**
 * Integration test for agent-comms#283, over real WireMeshTransport instances: a DM whose first attempt never reached its recipient must be reported as queued and undelivered rather than worded like a delivery, and must actually be delivered, and reported delivered, once a route to that recipient exists again. The recipient restarts against its own persisted identity slot, so it comes back as the same device the queued message is addressed to, exactly as a restarted bridge does in production.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import {
  releaseIdentityLock,
  type IdentitySlot,
} from "../core/identity-store.js";
import type { DeliveryEvent } from "../core/types.js";
import { waitFor, wireTestTransport } from "./test-transport.js";
import { TeardownStack } from "./hub-helpers.js";

/** Well clear of 19876, the well-known coordinator port a developer's own real bridges bind on the machine running these tests. */
let nextPort = 22_900;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

const cleanups = new TeardownStack();

afterEach(async () => {
  await cleanups.run();
});

/** A store wired like a real bridge, registered and initialised, recording every delivery event pushed to it. */
async function makeStore(
  coordinatorPort: number,
  name: string,
  slot?: Readonly<IdentitySlot>,
): Promise<{
  store: MeshStore;
  slot: IdentitySlot;
  deliveries: DeliveryEvent[];
}> {
  const store = new MeshStore({ coordinatorPort });
  const deliveries: DeliveryEvent[] = [];
  store.onDelivery = (_agentId, event) => {
    deliveries.push(event);
  };
  const resolvedSlot = await wireTestTransport(store, { slot });
  await store.init();
  await store.registerAgent({
    name,
    harness: "test",
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  return { store, slot: resolvedSlot, deliveries };
}

/** Every delivery status this store was pushed about the given message. */
function statusesFor(
  deliveries: readonly DeliveryEvent[],
  messageId: string,
): Extract<DeliveryEvent, { type: "delivery_status" }>[] {
  return deliveries.filter(
    (event): event is Extract<DeliveryEvent, { type: "delivery_status" }> =>
      event.type === "delivery_status" && event.messageId === messageId,
  );
}

describe("DM delivery status", () => {
  it("reports a DM as queued while its recipient is away, then delivers it and reports it delivered once the recipient returns", async () => {
    const port = freshPort();
    const sender = await makeStore(port, "sender");
    cleanups.push(async () => sender.store.shutdown());
    const recipient = await makeStore(port, "recipient");

    await waitFor(
      () =>
        sender.store.serialise().agents[recipient.store.peerId] !== undefined,
      "the sender to see the recipient on the mesh",
    );

    // First contact asks the recipient for access, exactly as it did before this change: a refused or unanswered request still fails the call outright rather than being queued.
    const accessRequested = sender.store.requestDmAccess(
      recipient.store.peerId,
    );
    await waitFor(
      () => recipient.store.listPendingRoomJoins().length === 1,
      "the recipient to see the DM request",
    );
    const pending = recipient.store.listPendingRoomJoins()[0];
    if (pending === undefined) throw new Error("expected a pending request");
    recipient.store.acceptRoomJoin(pending.roomPath, sender.store.peerId);
    await accessRequested;

    const straightThrough = await sender.store.sendDm(
      sender.store.peerId,
      recipient.store.peerId,
      "while you are here",
    );
    expect(straightThrough.delivery).toEqual({ status: "delivered" });

    const recipientPeerId = recipient.store.peerId;
    await recipient.store.shutdown();
    releaseIdentityLock(recipient.slot);
    await waitFor(
      () =>
        sender.store.serialise().agents[recipientPeerId]?.status !== "active",
      "the sender to notice the recipient has gone",
    );

    // With no session left, routing falls through to the hub, and this store has no hub connection: the recipient is unreachable by any route rather than refusing anything, which is the state a retry can still fix.
    sender.store.addTrustedGateway(recipientPeerId);
    const queued = await sender.store.sendDm(
      sender.store.peerId,
      recipientPeerId,
      "while you were out",
    );
    // Which transient reason depends on whether the closed session has already been reaped when the send runs: an already-reaped one leaves no route at all, while one still in the map rejects as its socket goes. Both are the same "nobody answered" fact, and both are what the queue exists for; the point under test is that neither is reported as a delivery.
    expect(queued.delivery).toMatchObject({ status: "queued" });
    expect(["not_connected", "connection_lost", "timeout"]).toContain(
      queued.delivery.status === "queued" ? queued.delivery.reason : undefined,
    );
    expect(statusesFor(sender.deliveries, queued.message.id)).toEqual([]);

    const restarted = await makeStore(port, "recipient", recipient.slot);
    cleanups.push(async () => restarted.store.shutdown());
    expect(restarted.store.peerId).toBe(recipientPeerId);

    await waitFor(
      () =>
        restarted.deliveries.some(
          (event) =>
            event.type === "dm" && event.message.id === queued.message.id,
        ),
      "the queued DM to reach the restarted recipient",
    );
    await waitFor(
      () =>
        statusesFor(sender.deliveries, queued.message.id).some(
          (event) => event.delivery.status === "delivered",
        ),
      "the sender to be told the queued DM was delivered",
    );
  });
});
