/**
 * CoordinatorRole's election behaviour (agent-comms#341) over an in-memory bus: several roles, each gossiping its claims to every other exactly as WireMeshTransport gossips them over machine-local sessions, so convergence, supersession and the no-echo rule are observable without sockets.
 */

import { afterEach, test, expect, vi } from "vitest";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import type { CoordinatorFrame } from "wire-mesh-core/generated/protocol";
import { CoordinatorRole } from "../core/coordinator-role.js";
import { ROOM_REQUEST_TIMEOUT_MS } from "../core/request-timeouts.js";
import type { ConnectionHandle } from "../core/transport.js";

const DEVICE_ID_HEX_LENGTH = 64;
/** How many times a run of takeovers may double its wait within the test's simulated span. */
const BACKOFF_DOUBLINGS = 5;
/** The roles in that run that cannot reach the other's claim's holder, and so keep taking over. */
const MUTUALLY_UNREACHABLE_ROLES = 2;
/** The term a holder is raised to before a lower-term claim from a lagging peer counts as stale. */
const RAISED_TERM = 2;
/** A term above RAISED_TERM, as a later takeover would use. */
const LATER_TERM = RAISED_TERM + 1;
/** How many times a lagging peer repeats the same stale claim. */

/** Answers a holder has sent after: one to the first peer, one to the second, none to the first's repeat. */
const FIRST_ANSWERS = 2;

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
  /** Who has a machine-local session with whom, when the mesh is not fully connected; undefined means every pair is connected. */
  private links: Map<string, Set<string>> | undefined;
  private readonly queue: {
    from: string;
    to: string;
    frame: CoordinatorFrame;
  }[] = [];

  /** Connects exactly these pairs; every other pair has no session, so frames between them are never delivered and neither counts as the other's election peer. */
  linkOnly(pairs: readonly (readonly [string, string])[]): void {
    this.links = new Map();
    for (const [a, b] of pairs) {
      this.links.set(a, (this.links.get(a) ?? new Set()).add(b));
      this.links.set(b, (this.links.get(b) ?? new Set()).add(a));
    }
  }

  private reaches(from: string, to: string): boolean {
    return this.links === undefined || this.links.get(from)?.has(to) === true;
  }

  add(id: string): Member {
    const member: Member = {
      id,
      role: new CoordinatorRole({
        getPeerId: () => id,
        claimWaitMs: ROOM_REQUEST_TIMEOUT_MS,
        requireTransport: () => ({
          broadcastCoordinatorClaim: async (frame) => {
            member.sent.push(frame);
            for (const other of this.members.keys()) {
              if (other !== id && this.reaches(id, other)) {
                this.queue.push({ from: id, to: other, frame });
              }
            }
          },
          sendCoordinatorClaim: async (handle, frame) => {
            member.sent.push(frame);
            if (this.reaches(id, handle.id)) {
              this.queue.push({ from: id, to: handle.id, frame });
            }
          },
          // Every other member on the bus has a machine-local session to this one; remove() is a session closing.
          electionPeerIds: () =>
            new Set(
              [...this.members.keys()].filter(
                (other) => other !== id && this.reaches(id, other),
              ),
            ),
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

function claimFor(holderHex: string, term: number): CoordinatorFrame {
  return { type: "coordinator", term, coordinator: deviceIdFromHex(holderHex) };
}

afterEach(() => {
  vi.useRealTimers();
});

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

test("a peer that keeps sending the same stale claim is answered with the incumbent once, not once per claim", async () => {
  const bus = new Bus();
  const holder = bus.add(hexId("9"));
  await holder.role.claimIfVacant();
  await holder.role.handleClaim(
    { id: holder.id },
    claimFor(holder.id, RAISED_TERM),
  );
  holder.sent.length = 0;
  const stale = claimFor(hexId("1"), 0);

  for (let repeat = 0; repeat < DEVICE_ID_HEX_LENGTH; repeat += 1) {
    await holder.role.handleClaim({ id: hexId("1") }, stale);
  }

  expect(holder.sent).toEqual([claimFor(holder.id, RAISED_TERM)]);
});

test("each peer is answered once per incumbent, and again once the incumbent changes", async () => {
  const bus = new Bus();
  const holder = bus.add(hexId("9"));
  await holder.role.claimIfVacant();
  await holder.role.handleClaim(
    { id: holder.id },
    claimFor(holder.id, RAISED_TERM),
  );
  holder.sent.length = 0;
  const staleFromOne = claimFor(hexId("1"), 0);
  const staleFromTwo = claimFor(hexId("2"), 0);
  await holder.role.handleClaim({ id: hexId("1") }, staleFromOne);
  await holder.role.handleClaim({ id: hexId("2") }, staleFromTwo);
  await holder.role.handleClaim({ id: hexId("1") }, staleFromOne);
  expect(holder.sent).toEqual([
    claimFor(holder.id, RAISED_TERM),
    claimFor(holder.id, RAISED_TERM),
  ]);

  await holder.role.handleClaim(
    { id: hexId("3") },
    claimFor(hexId("3"), LATER_TERM + 1),
  );
  holder.sent.length = 0;
  await holder.role.handleClaim({ id: hexId("1") }, staleFromOne);
  await holder.role.handleClaim({ id: hexId("1") }, staleFromOne);

  expect(holder.sent).toEqual([claimFor(hexId("3"), LATER_TERM + 1)]);
});

test("a peer whose session was enrolled afresh is answered again, since its earlier answer may have been lost with the old session", async () => {
  const bus = new Bus();
  const holder = bus.add(hexId("9"));
  await holder.role.claimIfVacant();
  await holder.role.handleClaim(
    { id: holder.id },
    claimFor(holder.id, RAISED_TERM),
  );
  holder.sent.length = 0;
  const stale = claimFor(hexId("1"), 0);
  await holder.role.handleClaim({ id: hexId("1") }, stale);
  await holder.role.handleClaim({ id: hexId("1") }, stale);
  expect(holder.sent).toHaveLength(1);

  await holder.role.announceTo({ id: hexId("1") });
  await holder.role.handleClaim({ id: hexId("1") }, stale);

  expect(holder.sent).toHaveLength(FIRST_ANSWERS + 1);
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

test("a store that may not be alone claims the vacant role once the claim wait passes with no incumbent heard", async () => {
  vi.useFakeTimers();
  const bus = new Bus();
  const only = bus.add(hexId("5"));

  only.role.claimIfVacantAfterWait();
  expect(only.role.current()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(ROOM_REQUEST_TIMEOUT_MS);

  expect(only.role.current()).toEqual({ term: 0, holder: only.id });
  expect(only.role.isHolder()).toBe(true);
});

test("a lower-id newcomer waiting to claim never takes the role from an incumbent whose claim reaches it within the wait", async () => {
  vi.useFakeTimers();
  const bus = new Bus();
  const holder = bus.add(hexId("5"));
  const newcomer = bus.add(hexId("1"));
  await holder.role.claimIfVacant();

  newcomer.role.claimIfVacantAfterWait();
  await bus.settle();
  await vi.advanceTimersByTimeAsync(ROOM_REQUEST_TIMEOUT_MS);
  await bus.settle();

  expect(bus.holders()).toEqual([holder.id]);
  expect(newcomer.role.current()).toEqual({ term: 0, holder: holder.id });
  expect(newcomer.gains).toBe(0);
  expect(holder.losses).toBe(0);
});

test("a claim naming a device this side has no session to is taken over at a raised term one claim wait later", async () => {
  vi.useFakeTimers();
  const bus = new Bus();
  const self = bus.add(hexId("5"));
  const absentTerm = 3;

  await self.role.handleClaim(
    { id: hexId("7") },
    claimFor(hexId("1"), absentTerm),
  );
  expect(self.role.isHolder()).toBe(false);
  await vi.advanceTimersByTimeAsync(ROOM_REQUEST_TIMEOUT_MS);

  expect(self.role.current()).toEqual({
    term: absentTerm + 1,
    holder: self.id,
  });
  expect(self.role.isHolder()).toBe(true);
});

test("a claim naming a holder that this side reaches within the claim wait is left standing", async () => {
  vi.useFakeTimers();
  const bus = new Bus();
  const self = bus.add(hexId("5"));
  const holderId = hexId("1");
  const term = 3;

  await self.role.handleClaim({ id: hexId("7") }, claimFor(holderId, term));
  bus.add(holderId);
  await vi.advanceTimersByTimeAsync(ROOM_REQUEST_TIMEOUT_MS);

  expect(self.role.current()).toEqual({ term, holder: holderId });
  expect(self.role.isHolder()).toBe(false);
  expect(self.gains).toBe(0);
});

test("a role lost and regained while its duties are still stopping starts them again only once they have stopped", async () => {
  const selfId = hexId("2");
  const rivalId = hexId("1");
  const electionPeers = new Set([rivalId]);
  const log: string[] = [];
  const gate = { open: (): void => {} };
  const stopping = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  const role = new CoordinatorRole({
    getPeerId: () => selfId,
    claimWaitMs: ROOM_REQUEST_TIMEOUT_MS,
    requireTransport: () => ({
      broadcastCoordinatorClaim: async () => {},
      sendCoordinatorClaim: async () => {},
      electionPeerIds: () => electionPeers,
    }),
    onGained: async () => {
      log.push("gained");
    },
    onLost: async () => {
      log.push("stopping");
      await stopping;
      log.push("stopped");
    },
    onError: (error) => {
      throw error;
    },
  });
  await role.claimIfVacant();

  const nextMacrotask = async (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });
  // A higher-term claim takes the role away, and onLost starts; its holder then leaves, so this side is the lowest survivor and claims straight back while onLost is still waiting.
  const losing = role.handleClaim({ id: rivalId }, claimFor(rivalId, 1));
  await nextMacrotask();
  expect(log).toEqual(["gained", "stopping"]);
  electionPeers.delete(rivalId);
  const regaining = role.handleDeparture(rivalId, async () => {});
  await nextMacrotask();
  expect(log).toEqual(["gained", "stopping"]);

  gate.open();
  await Promise.all([losing, regaining]);

  expect(log).toEqual(["gained", "stopping", "stopped", "gained"]);
  expect(role.isHolder()).toBe(true);
  expect(role.current()).toEqual({ term: 2, holder: selfId });
});

test("a claim at a term no later claim could supersede is dropped without gossip or reply, leaving the incumbent untouched", async () => {
  const bus = new Bus();
  const holder = bus.add(hexId("5"));
  const peer = bus.add(hexId("9"));
  await holder.role.claimIfVacant();
  await bus.settle();
  holder.sent.length = 0;

  await holder.role.handleClaim(
    { id: peer.id },
    claimFor(peer.id, Number.MAX_SAFE_INTEGER),
  );
  await bus.settle();

  expect(holder.sent).toEqual([]);
  expect(holder.role.current()).toEqual({ term: 0, holder: holder.id });
  expect(holder.role.isHolder()).toBe(true);
});

test("a vacant store hearing an unsupersedable claim stays vacant", async () => {
  const bus = new Bus();
  const listener = bus.add(hexId("5"));

  await listener.role.handleClaim(
    { id: hexId("9") },
    claimFor(hexId("9"), Number.MAX_SAFE_INTEGER),
  );

  expect(listener.role.current()).toBeUndefined();
  expect(listener.sent).toEqual([]);
});

test("in a mesh where the incumbent is unreachable to some roles, takeovers back off instead of raising the term at every claim wait", async () => {
  vi.useFakeTimers();
  const bus = new Bus();
  const left = bus.add(hexId("1"));
  const middle = bus.add(hexId("5"));
  const right = bus.add(hexId("9"));
  // The outer two share no session, so whichever claims, the other has no session to the holder.
  bus.linkOnly([
    [left.id, middle.id],
    [middle.id, right.id],
  ]);
  await left.role.claimIfVacant();
  await bus.settle();

  for (let wait = 0; wait < 2 ** BACKOFF_DOUBLINGS; wait += 1) {
    await vi.advanceTimersByTimeAsync(ROOM_REQUEST_TIMEOUT_MS);
    await bus.settle();
  }

  // Each takeover waits twice as long as the last, so the simulated span holds one claim per doubling from each of the two roles that cannot reach each other, plus the first claim; without backoff every wait raises the term once.
  expect(middle.role.current()?.term).toBeLessThanOrEqual(
    MUTUALLY_UNREACHABLE_ROLES * (BACKOFF_DOUBLINGS + 1),
  );
});
