/**
 * CoordinatorRole's election behaviour (agent-comms#341) over an in-memory bus: several roles, each gossiping its claims to every other exactly as WireMeshTransport gossips them over machine-local sessions, so convergence, supersession and the no-echo rule are observable without sockets.
 */

import { test, expect } from "vitest";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import type { CoordinatorFrame } from "wire-mesh-core/generated/protocol";
import { CoordinatorRole } from "../core/coordinator-role.js";
import type { ConnectionHandle } from "../core/transport.js";

const DEVICE_ID_HEX_LENGTH = 64;

interface Member {
  id: string;
  role: CoordinatorRole;
  gains: number;
  losses: number;
  /** Every frame this member sent, broadcast or directed. */
  sent: CoordinatorFrame[];
}

/** Delivers every frame a member sends to its recipients, one hop, the way a machine-local session does. Frames are queued rather than delivered inline so a reply cannot re-enter the sender mid-evaluation, matching the asynchronous delivery a real session gives. */
class Bus {
  readonly members = new Map<string, Member>();
  private readonly queue: {
    from: string;
    to: string;
    frame: CoordinatorFrame;
  }[] = [];

  add(id: string): Member {
    const member: Member = {
      id,
      role: new CoordinatorRole({
        getPeerId: () => id,
        livePeerIds: () => this.members.keys(),
        requireTransport: () => ({
          broadcastCoordinatorClaim: async (frame) => {
            member.sent.push(frame);
            for (const other of this.members.keys()) {
              if (other !== id) this.queue.push({ from: id, to: other, frame });
            }
          },
          sendCoordinatorClaim: async (handle, frame) => {
            member.sent.push(frame);
            this.queue.push({ from: id, to: handle.id, frame });
          },
        }),
        onGained: async () => {
          member.gains += 1;
        },
        onLost: async () => {
          member.losses += 1;
        },
        onError: (error) => {
          throw error;
        },
      }),
      gains: 0,
      losses: 0,
      sent: [],
    };
    this.members.set(id, member);
    return member;
  }

  remove(id: string): void {
    this.members.delete(id);
  }

  /** Delivers queued frames until none remain, returning how many were delivered; throws past a bound so an echo loop fails the test instead of hanging it. */
  async settle(): Promise<number> {
    const bound = 1000;
    let delivered = 0;
    for (
      let next = this.queue.shift();
      next !== undefined;
      next = this.queue.shift()
    ) {
      delivered += 1;
      if (delivered > bound) throw new Error("claims never stopped echoing");
      const recipient = this.members.get(next.to);
      if (recipient === undefined) continue;
      const handle: ConnectionHandle = { id: next.from };
      await recipient.role.handleClaim(handle, next.frame);
    }
    return delivered;
  }

  holders(): string[] {
    return [...this.members.values()]
      .filter((member) => member.role.isHolder())
      .map((member) => member.id);
  }
}

function hexId(digit: string): string {
  return digit.repeat(DEVICE_ID_HEX_LENGTH);
}

test("a lone store that claims the vacant role holds it at term 0", async () => {
  const bus = new Bus();
  const only = bus.add(hexId("5"));

  await only.role.claimIfVacant();

  expect(only.role.isHolder()).toBe(true);
  expect(only.role.current()).toEqual({ term: 0, holder: only.id });
  expect(only.gains).toBe(1);
});

test("claimIfVacant never claims over a claim this side has already heard", async () => {
  const bus = new Bus();
  const holder = bus.add(hexId("5"));
  const joiner = bus.add(hexId("1"));
  await holder.role.claimIfVacant();
  await bus.settle();

  await joiner.role.claimIfVacant();

  expect(joiner.role.isHolder()).toBe(false);
  expect(bus.holders()).toEqual([holder.id]);
});

test("several stores that each claimed while alone converge on exactly one holder, the lowest device-id", async () => {
  const bus = new Bus();
  const members = [
    bus.add(hexId("7")),
    bus.add(hexId("3")),
    bus.add(hexId("9")),
  ];
  for (const member of members) await member.role.claimIfVacant();

  await bus.settle();

  expect(bus.holders()).toEqual([hexId("3")]);
  for (const member of members) {
    expect(member.role.current()).toEqual({ term: 0, holder: hexId("3") });
  }
  const loser = members[0];
  expect(loser?.gains).toBe(1);
  expect(loser?.losses).toBe(1);
});

test("a stale claim is answered with the incumbent, and its sender converges on it", async () => {
  const bus = new Bus();
  const holder = bus.add(hexId("9"));
  await holder.role.claimIfVacant();
  // A takeover nobody else heard puts the holder on a higher term than a newcomer that claims while alone.
  const raisedTerm = 2;
  await holder.role.handleClaim(
    { id: holder.id },
    {
      type: "coordinator",
      term: raisedTerm,
      coordinator: deviceIdFromHex(holder.id),
    },
  );
  const behind = bus.add(hexId("1"));
  holder.sent.length = 0;

  await behind.role.claimIfVacant();
  await bus.settle();

  expect(holder.sent).toEqual([
    {
      type: "coordinator",
      term: raisedTerm,
      coordinator: deviceIdFromHex(holder.id),
    },
  ]);
  expect(behind.role.current()).toEqual({
    term: raisedTerm,
    holder: holder.id,
  });
  expect(bus.holders()).toEqual([holder.id]);
});

test("two stores that agree on the incumbent never echo it back and forth", async () => {
  const bus = new Bus();
  const holder = bus.add(hexId("2"));
  const follower = bus.add(hexId("8"));
  await holder.role.claimIfVacant();
  await bus.settle();
  follower.sent.length = 0;

  await holder.role.announceTo({ id: follower.id });
  const delivered = await bus.settle();

  expect(delivered).toBe(1);
  expect(follower.sent).toEqual([]);
});

test("announceTo tells a joiner the incumbent, so the joiner never claims over it", async () => {
  const bus = new Bus();
  const holder = bus.add(hexId("6"));
  await holder.role.claimIfVacant();
  const joiner = bus.add(hexId("1"));

  await holder.role.announceTo({ id: joiner.id });
  await bus.settle();
  await joiner.role.claimIfVacant();
  await bus.settle();

  expect(joiner.role.current()).toEqual({ term: 0, holder: holder.id });
  expect(bus.holders()).toEqual([holder.id]);
});

test("the holder's departure is recovered by the lowest survivor raising the term, and every survivor accepts it", async () => {
  const bus = new Bus();
  const holder = bus.add(hexId("1"));
  const low = bus.add(hexId("4"));
  const high = bus.add(hexId("8"));
  await holder.role.claimIfVacant();
  await bus.settle();

  bus.remove(holder.id);
  await low.role.handleDeparture(holder.id, async () => {});
  await high.role.handleDeparture(holder.id, async () => {});
  await bus.settle();

  expect(bus.holders()).toEqual([low.id]);
  expect(high.role.current()).toEqual({ term: 1, holder: low.id });
});

test("stop gives the role up exactly once and ignores later claims", async () => {
  const bus = new Bus();
  const holder = bus.add(hexId("3"));
  await holder.role.claimIfVacant();

  await holder.role.stop();
  await holder.role.stop();
  await holder.role.handleClaim(
    { id: hexId("1") },
    { type: "coordinator", term: 5, coordinator: deviceIdFromHex(holder.id) },
  );

  expect(holder.role.isHolder()).toBe(false);
  expect(holder.losses).toBe(1);
});
