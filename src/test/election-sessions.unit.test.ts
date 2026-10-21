/**
 * ElectionSessions' outbound claims over a session whose peer reads slowly: a claim is idempotent state that a later claim supersedes, so at most one send is in flight per session and a newer claim replaces a waiting one instead of queueing behind it (agent-comms#434, claims piling up in the write queue of a session whose peer did not keep up).
 */

import { expect, test } from "vitest";
import type { AcceptedMeshSession } from "wire-mesh-core/domain/mesh-session";
import type { CoordinatorFrame } from "wire-mesh-core/generated/protocol";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { ElectionSessions } from "../core/election-sessions.js";

const DEVICE_ID_HEX_LENGTH = 64;
/** Claims sent in order to a peer that keeps up. */
const IN_ORDER = 3;
/** Claims a busy election sends behind one unread send: more than one, so all but the newest are replaced. */
const BURST = IN_ORDER + 1;
const LAST_OF_BURST = BURST - 1;

interface FakeSession {
  session: AcceptedMeshSession;
  /** Every frame handed to the session, in order. */
  sent: CoordinatorFrame[];
  /** Settles the oldest send still waiting on the peer. */
  finishOne: () => void;
}

/** A session whose sendCoordinatorClaim settles only when the test says the peer has read the frame. */
function fakeSession(): FakeSession {
  const sent: CoordinatorFrame[] = [];
  const waiting: (() => void)[] = [];
  const session = {
    coordinatorFrames: (async function* () {})(),
    sendCoordinatorClaim: async (frame: CoordinatorFrame) => {
      sent.push(frame);
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    },
  } as unknown as AcceptedMeshSession;
  return {
    session,
    sent,
    finishOne: () => {
      waiting.shift()?.();
    },
  };
}

function claim(term: number): CoordinatorFrame {
  return {
    type: "coordinator",
    term,
    coordinator: deviceIdFromHex("1".repeat(DEVICE_ID_HEX_LENGTH)),
  };
}

function enrolled(fake: FakeSession, id = "a"): ElectionSessions {
  const sessions = new ElectionSessions({
    onCoordinatorClaim: () => {},
    onElectionSessionEnrolled: () => {},
    onError: (error) => {
      throw error;
    },
  });
  sessions.enrol(fake.session, { id });
  return sessions;
}

const tick = async (): Promise<void> => {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
};

test("claims sent while the previous one is still unread are replaced by the newest, so the queue stays at one", async () => {
  const fake = fakeSession();
  const sessions = enrolled(fake);

  for (let term = 0; term < BURST; term += 1) {
    void sessions.broadcast(claim(term));
  }
  await tick();

  expect(fake.sent).toEqual([claim(0)]);
  fake.finishOne();
  await tick();
  expect(fake.sent).toEqual([claim(0), claim(LAST_OF_BURST)]);
});

test("every claim is sent in order when the peer keeps up", async () => {
  const fake = fakeSession();
  const sessions = enrolled(fake);

  for (let term = 0; term < IN_ORDER; term += 1) {
    const sending = sessions.broadcast(claim(term));
    await tick();
    fake.finishOne();
    await sending;
  }

  expect(fake.sent).toEqual([claim(0), claim(1), claim(2)]);
});

test("a slow session does not hold back claims to another session", async () => {
  const slow = fakeSession();
  const quick = fakeSession();
  const sessions = enrolled(slow, "slow");
  sessions.enrol(quick.session, { id: "quick" });

  void sessions.broadcast(claim(0));
  void sessions.broadcast(claim(1));
  await tick();
  quick.finishOne();
  await tick();

  expect(slow.sent).toEqual([claim(0)]);
  expect(quick.sent).toEqual([claim(0), claim(1)]);
});

test("a session that closes forgets its waiting claim", async () => {
  const fake = fakeSession();
  const sessions = enrolled(fake);
  void sessions.broadcast(claim(0));
  void sessions.broadcast(claim(1));
  await tick();

  sessions.delete(fake.session);
  fake.finishOne();
  await tick();

  expect(fake.sent).toEqual([claim(0)]);
});
