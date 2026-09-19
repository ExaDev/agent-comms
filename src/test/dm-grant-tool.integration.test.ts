/**
 * Integration test for pre-authorised DMs through the tool surface: the receiver admits the sender (dm_admit), the sender presents the grant (dm_use_grant), and the first DM is delivered with no decision at the receiving end. A grant minted for someone else, or revoked, is refused.
 */

import { test, expect } from "vitest";
import { MeshStore } from "../core/mesh-store.js";
import { CommsTool } from "../core/tool.js";
import { dmRoomPath } from "../core/room-path.js";
import type { CommsContext } from "../core/tool.js";
import { waitFor, wireTestTransport } from "./test-transport.js";

let nextPort = 25_450;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

interface Party {
  store: MeshStore;
  tool: CommsTool;
  ctx: CommsContext;
}

async function party(port: number, name: string): Promise<Party> {
  const store = new MeshStore({ coordinatorPort: port });
  await wireTestTransport(store);
  await store.init();
  await store.registerAgent({
    name,
    harness: "test",
    cwd: `/test/${name}`,
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  return {
    store,
    tool: new CommsTool(store),
    ctx: {
      agentId: store.peerId,
      harness: "test",
      cwd: `/test/${name}`,
      pid: process.pid,
    },
  };
}

async function connectedPair(): Promise<{ sender: Party; receiver: Party }> {
  const port = freshPort();
  const sender = await party(port, "sender");
  const receiver = await party(port, "receiver");
  await waitFor(
    () => sender.store.serialise().agents[receiver.store.peerId] !== undefined,
    "the sender sees the receiver",
  );
  return { sender, receiver };
}

/** The grant text in a dm_admit result: its last line. */
function grantFrom(content: string): string {
  const line = content.split("\n").at(-1);
  if (line === undefined || line === "") throw new Error("no grant in result");
  return line;
}

test("a grant lets the sender's first DM through with no decision at the receiver", async () => {
  const { sender, receiver } = await connectedPair();

  try {
    const admitted = await receiver.tool.handle(receiver.ctx, {
      action: "dm_admit",
      target: sender.store.peerId,
    });
    expect(admitted.isError).toBe(false);
    expect(admitted.content).toContain(
      `dm_use_grant with target ${receiver.store.peerId}`,
    );

    const used = await sender.tool.handle(sender.ctx, {
      action: "dm_use_grant",
      target: receiver.store.peerId,
      grant: grantFrom(admitted.content),
    });
    expect(used.isError).toBe(false);
    expect(receiver.store.listPendingRoomJoins()).toEqual([]);

    const sent = await sender.tool.handle(sender.ctx, {
      action: "dm",
      target: receiver.store.peerId,
      content: "no decision needed",
    });
    expect(sent.isError).toBe(false);

    const dmPath = dmRoomPath(sender.store.peerId, receiver.store.peerId);
    await waitFor(
      () =>
        (receiver.store.serialise().dms[dmPath] ?? []).some(
          (m) => m.content === "no decision needed",
        ),
      "the receiver gets the DM",
    );
    expect(receiver.store.listPendingRoomJoins()).toEqual([]);
  } finally {
    await receiver.store.shutdown();
    await sender.store.shutdown();
  }
});

test("a grant minted for a different device is refused", async () => {
  const { sender, receiver } = await connectedPair();

  try {
    const someoneElse = "c".repeat(sender.store.peerId.length);
    const admitted = await receiver.tool.handle(receiver.ctx, {
      action: "dm_admit",
      target: someoneElse,
    });

    const used = await sender.tool.handle(sender.ctx, {
      action: "dm_use_grant",
      target: receiver.store.peerId,
      grant: grantFrom(admitted.content),
    });

    expect(used.isError).toBe(true);
    expect(used.content).toMatch(/refused/);
  } finally {
    await receiver.store.shutdown();
    await sender.store.shutdown();
  }
});

test("a revoked grant is refused", async () => {
  const { sender, receiver } = await connectedPair();

  try {
    const admitted = await receiver.tool.handle(receiver.ctx, {
      action: "dm_admit",
      target: sender.store.peerId,
    });
    const revoked = await receiver.tool.handle(receiver.ctx, {
      action: "dm_revoke",
      target: sender.store.peerId,
    });
    expect(revoked.isError).toBe(false);

    const used = await sender.tool.handle(sender.ctx, {
      action: "dm_use_grant",
      target: receiver.store.peerId,
      grant: grantFrom(admitted.content),
    });

    expect(used.isError).toBe(true);
    expect(used.content).toMatch(/refused/);
  } finally {
    await receiver.store.shutdown();
    await sender.store.shutdown();
  }
});

test("dm_use_grant with text that is not a grant fails without contacting the receiver", async () => {
  const { sender, receiver } = await connectedPair();

  try {
    const used = await sender.tool.handle(sender.ctx, {
      action: "dm_use_grant",
      target: receiver.store.peerId,
      grant: "this is not a grant",
    });

    expect(used.isError).toBe(true);
    expect(used.content).toMatch(/not a valid capability token/);
    expect(receiver.store.listPendingRoomJoins()).toEqual([]);
  } finally {
    await receiver.store.shutdown();
    await sender.store.shutdown();
  }
});
