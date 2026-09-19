/**
 * Integration test for pre-authorised DMs through the tool surface: the receiver admits the sender (dm_admit), the sender presents the grant (dm_use_grant), and the first DM is delivered with no decision at the receiving end. A grant minted for someone else, or revoked, is refused.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
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
    expect(used.content).toMatch(/not issued to this device or its user/);
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

/** A party whose user principal is fixed by the caller, so two of them can be two devices of one person. */
async function partyOfUser(
  port: number,
  name: string,
  userIdentityDir: string,
): Promise<Party> {
  const store = new MeshStore({ coordinatorPort: port });
  await wireTestTransport(store, {
    userIdentityOptions: { dir: userIdentityDir },
  });
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

/** The principal id in a whoami result. */
function principalFrom(content: string): string {
  const line = content.split("\n").find((l) => l.startsWith("Principal: "));
  if (line === undefined) throw new Error("whoami reported no principal");
  return line.slice("Principal: ".length);
}

test("whoami reports the user principal, so a person can hand it to someone who wants to admit them", async () => {
  const { sender } = await connectedPair();

  try {
    const whoami = await sender.tool.handle(sender.ctx, { action: "whoami" });

    expect(whoami.content).toMatch(/^Principal: [0-9a-f]{64}$/m);
    expect(whoami.content).not.toContain(`Principal: ${sender.store.peerId}`);
  } finally {
    await sender.store.shutdown();
  }
});

test("admitting a person's principal lets every one of their devices DM with no decision, from the same grant text", async () => {
  const port = freshPort();
  const receiver = await party(port, "receiver");
  const dir = fs.mkdtempSync(path.join(tmpdir(), "dm-grant-user-"));
  const first = await partyOfUser(port, "first-device", dir);
  const second = await partyOfUser(port, "second-device", dir);

  try {
    const principal = principalFrom(
      (await first.tool.handle(first.ctx, { action: "whoami" })).content,
    );
    expect(
      principalFrom(
        (await second.tool.handle(second.ctx, { action: "whoami" })).content,
      ),
    ).toBe(principal);

    const admitted = await receiver.tool.handle(receiver.ctx, {
      action: "dm_admit",
      target: principal,
      principal: true,
    });
    expect(admitted.isError).toBe(false);
    const grant = grantFrom(admitted.content);

    for (const device of [first, second]) {
      const used = await device.tool.handle(device.ctx, {
        action: "dm_use_grant",
        target: receiver.store.peerId,
        grant,
      });
      expect(used.isError, used.content).toBe(false);
      expect(receiver.store.listPendingRoomJoins()).toEqual([]);

      const sent = await device.tool.handle(device.ctx, {
        action: "dm",
        target: receiver.store.peerId,
        content: `hello from ${device.ctx.cwd}`,
      });
      expect(sent.isError, sent.content).toBe(false);
    }
  } finally {
    await second.store.shutdown();
    await first.store.shutdown();
    await receiver.store.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a principal-level grant is refused when presented from a device of some other user", async () => {
  const port = freshPort();
  const receiver = await party(port, "receiver");
  const owner = await party(port, "owner");
  const stranger = await party(port, "stranger");

  try {
    const ownerPrincipal = principalFrom(
      (await owner.tool.handle(owner.ctx, { action: "whoami" })).content,
    );
    const admitted = await receiver.tool.handle(receiver.ctx, {
      action: "dm_admit",
      target: ownerPrincipal,
      principal: true,
    });

    const used = await stranger.tool.handle(stranger.ctx, {
      action: "dm_use_grant",
      target: receiver.store.peerId,
      grant: grantFrom(admitted.content),
    });

    expect(used.isError).toBe(true);
    expect(used.content).toMatch(/not issued to this device or its user/);
  } finally {
    await stranger.store.shutdown();
    await owner.store.shutdown();
    await receiver.store.shutdown();
  }
});
