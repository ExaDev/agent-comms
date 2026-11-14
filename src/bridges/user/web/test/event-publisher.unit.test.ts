/**
 * Resume rules of the event publisher: an id is `<instance>.<seq>`, a known id replays exactly the later events, and an id that cannot be resumed from (another instance, or older than the retained events) starts from a snapshot.
 */
import { getEventMeta } from "@orpc/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { meshContract, type MeshEvent } from "../contract.js";
import { INSTANCE_BYTES, MAX_EVENT_ID_LENGTH } from "../event-id.js";
import { MeshEventPublisher } from "../event-publisher.js";

/** Retention short enough to age events out by moving the faked clock. */
const RETENTION_MS = 1_000;
/** Hex characters of an instance. */
const INSTANCE_HEX_LENGTH = 16;
const EVENT_COUNT = 5;
const THREE = 3;
const TWO = 2;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const snapshot = (): MeshEvent => ({
  kind: "state_sync",
  state: { agents: {}, rooms: {}, messages: {}, dms: {} },
});

function patch(name: string): MeshEvent {
  return {
    kind: "state_patch",
    patch: { type: "agent_offline", agentId: name },
  };
}

/** What a subscriber sees of an event: the agent id of a patch, or "snapshot". */
function label(event: MeshEvent): string {
  if (event.kind === "state_sync") return "snapshot";
  if (event.kind === "state_patch" && "agentId" in event.patch) {
    return event.patch.agentId;
  }
  throw new Error("unexpected event");
}

/** Takes `count` events of a new subscription (with `lastEventId` when given), then stops it. */
async function take(
  publisher: MeshEventPublisher,
  count: number,
  lastEventId?: string,
): Promise<{ labels: string[]; ids: (string | undefined)[] }> {
  const labels: string[] = [];
  const ids: (string | undefined)[] = [];
  const subscription = publisher.subscribe({
    ...(lastEventId === undefined ? {} : { lastEventId }),
    snapshot,
  });
  while (labels.length < count) {
    const next = await subscription.next();
    if (next.done === true) break;
    labels.push(label(next.value));
    ids.push(getEventMeta(next.value)?.id);
  }
  await subscription.return(undefined);
  return { labels, ids };
}

/** The first event a new subscription yields, with a live event published right after subscribing: a subscriber that was wrongly treated as caught up gets that live event first, so the assertion fails instead of the test waiting for a snapshot that never comes. */
async function firstEvent(
  publisher: MeshEventPublisher,
  lastEventId: string,
): Promise<string> {
  const subscription = publisher.subscribe({ lastEventId, snapshot });
  const first = subscription.next();
  publisher.publish(patch("live-probe"));
  const next = await first;
  await subscription.return(undefined);
  if (next.done === true) throw new Error("the subscription ended");
  return label(next.value);
}

/** Publishes `e1` to `eN` and returns the id each was given, as a live subscriber saw them. */
async function publishNumbered(
  publisher: MeshEventPublisher,
  count: number,
  firstNumber = 1,
): Promise<string[]> {
  const live = publisher.subscribe({ snapshot });
  await live.next(); // snapshot
  for (let n = firstNumber; n < firstNumber + count; n++) {
    publisher.publish(patch(`e${String(n)}`));
  }
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const next = await live.next();
    const id = next.done === true ? undefined : getEventMeta(next.value)?.id;
    if (id === undefined) throw new Error("expected an id");
    ids.push(id);
  }
  await live.return(undefined);
  return ids;
}

function idAt(ids: readonly string[], index: number): string {
  const id = ids[index];
  if (id === undefined) throw new Error("no such id");
  return id;
}

it("numbers events as a 16 hex character instance and a sequence", async () => {
  const ids = await publishNumbered(new MeshEventPublisher(), 2);

  expect(ids[0]).toMatch(
    new RegExp(`^[0-9a-f]{${String(INSTANCE_HEX_LENGTH)}}\\.1$`, "u"),
  );
  expect(ids[1]?.split(".")[0]).toBe(ids[0]?.split(".")[0]);
  expect(ids[1]?.endsWith(".2")).toBe(true);
});

it("gives two publishers different instances", async () => {
  const [first] = await publishNumbered(new MeshEventPublisher(), 1);
  const [second] = await publishNumbered(new MeshEventPublisher(), 1);

  expect(first?.split(".")[0]).not.toBe(second?.split(".")[0]);
});

it("starts a subscriber with no id from a snapshot, then live events", async () => {
  const publisher = new MeshEventPublisher();
  await publishNumbered(publisher, 2);
  const live = publisher.subscribe({ snapshot });

  expect(label((await live.next()).value as MeshEvent)).toBe("snapshot");
  publisher.publish(patch("later"));
  expect(label((await live.next()).value as MeshEvent)).toBe("later");
  await live.return(undefined);
});

it("replays exactly the events after a known id, and no snapshot", async () => {
  const publisher = new MeshEventPublisher();
  const ids = await publishNumbered(publisher, EVENT_COUNT);

  const { labels } = await take(publisher, 2, idAt(ids, 2));

  expect(labels).toEqual(["e4", "e5"]);
});

it("replays nothing for the latest id, then delivers live events", async () => {
  const publisher = new MeshEventPublisher();
  const ids = await publishNumbered(publisher, TWO);
  const live = publisher.subscribe({ lastEventId: idAt(ids, 1), snapshot });
  const first = live.next();
  publisher.publish(patch("live"));

  expect(label((await first).value as MeshEvent)).toBe("live");
  await live.return(undefined);
});

it("loses no event published while a replay is being delivered, and repeats none", async () => {
  const publisher = new MeshEventPublisher();
  const ids = await publishNumbered(publisher, THREE);
  const live = publisher.subscribe({ lastEventId: idAt(ids, 0), snapshot });

  const first = await live.next();
  publisher.publish(patch("during"));
  const rest = [await live.next(), await live.next()];
  await live.return(undefined);

  expect(
    [first, ...rest].map((next) => label(next.value as MeshEvent)),
  ).toEqual(["e2", "e3", "during"]);
});

it("starts from a snapshot when the id is from another instance, as after a restart", async () => {
  const before = new MeshEventPublisher();
  const staleIds = await publishNumbered(before, 2);
  const restarted = new MeshEventPublisher();
  await publishNumbered(restarted, 2);

  expect(await firstEvent(restarted, idAt(staleIds, 0))).toBe("snapshot");
});

it("starts from a snapshot when the id is older than the oldest retained event", async () => {
  const publisher = new MeshEventPublisher({ retentionMs: RETENTION_MS });
  const ids = await publishNumbered(publisher, THREE);
  vi.advanceTimersByTime(RETENTION_MS + 1);
  await publishNumbered(publisher, TWO, THREE + 1);

  expect(await firstEvent(publisher, idAt(ids, 0))).toBe("snapshot");
});

it("replays every retained event for the id just before the oldest one, since nothing is missing", async () => {
  const publisher = new MeshEventPublisher({ retentionMs: RETENTION_MS });
  const ids = await publishNumbered(publisher, THREE);
  vi.advanceTimersByTime(RETENTION_MS + 1);
  await publishNumbered(publisher, TWO, THREE + 1);

  const { labels } = await take(publisher, 2, idAt(ids, 2));

  expect(labels).toEqual(["e4", "e5"]);
});

it("starts from a snapshot when nothing is retained and the id is not the latest", async () => {
  const publisher = new MeshEventPublisher({ retentionMs: RETENTION_MS });
  const ids = await publishNumbered(publisher, TWO);
  vi.advanceTimersByTime(RETENTION_MS + 1);

  expect(await firstEvent(publisher, idAt(ids, 0))).toBe("snapshot");
});

it("treats the latest id as caught up when nothing is retained", async () => {
  const publisher = new MeshEventPublisher({ retentionMs: RETENTION_MS });
  const ids = await publishNumbered(publisher, TWO);
  vi.advanceTimersByTime(RETENTION_MS + 1);
  const live = publisher.subscribe({ lastEventId: idAt(ids, 1), snapshot });
  const first = live.next();
  publisher.publish(patch("live"));

  expect(label((await first).value as MeshEvent)).toBe("live");
  await live.return(undefined);
});

it.each([
  ["not an id", () => "abc"],
  ["an instance with no sequence", (instance: string) => `${instance}.`],
  ["a non-numeric sequence", (instance: string) => `${instance}.x`],
  ["a signed sequence", (instance: string) => `${instance}.-1`],
  ["a fractional sequence", (instance: string) => `${instance}.1.5`],
  ["a bare number, the old format", () => "1"],
])("starts from a snapshot when the id is %s", async (_label, makeId) => {
  const publisher = new MeshEventPublisher();
  const ids = await publishNumbered(publisher, TWO);
  const [instance] = idAt(ids, 0).split(".");

  expect(await firstEvent(publisher, makeId(instance ?? ""))).toBe("snapshot");
});

it("starts from a snapshot when the id's sequence is ahead of anything published", async () => {
  const publisher = new MeshEventPublisher();
  const ids = await publishNumbered(publisher, 1);
  const [instance] = idAt(ids, 0).split(".");

  expect(await firstEvent(publisher, `${instance ?? ""}.99`)).toBe("snapshot");
});

it("refuses an id longer than any publisher issues before parsing it, even when its parts are valid", async () => {
  const publisher = new MeshEventPublisher();
  const ids = await publishNumbered(publisher, TWO);
  const [instance] = idAt(ids, 0).split(".");
  // Same instance and a sequence that would resume, padded past the longest id with leading zeros.
  const padded = `${instance ?? ""}.${"0".repeat(MAX_EVENT_ID_LENGTH)}1`;

  expect(padded.length).toBeGreaterThan(MAX_EVENT_ID_LENGTH);
  expect(await firstEvent(publisher, padded)).toBe("snapshot");
});

it("accepts an id of the longest length a publisher can issue", () => {
  expect(MAX_EVENT_ID_LENGTH).toBe(
    INSTANCE_BYTES * 2 + 1 + String(Number.MAX_SAFE_INTEGER).length,
  );
});

it("bounds what a client may send back as an id in the contract", async () => {
  const schema = meshContract.subscribeEvents["~orpc"].inputSchemas?.[0];
  if (!schema) throw new Error("subscribeEvents has no input schema");

  const atLimit = await schema["~standard"].validate({
    lastEventId: "x".repeat(MAX_EVENT_ID_LENGTH),
  });
  const pastLimit = await schema["~standard"].validate({
    lastEventId: "x".repeat(MAX_EVENT_ID_LENGTH + 1),
  });

  expect(atLimit.issues).toBeUndefined();
  expect(pastLimit.issues).toBeDefined();
});

it("keeps at most the configured count of events, judging an id that fell off the end as it judges an aged-out one", async () => {
  const publisher = new MeshEventPublisher({ maxBufferedEvents: THREE });
  const ids = await publishNumbered(publisher, THREE);

  // At the cap nothing is evicted: every event after the first replays.
  expect((await take(publisher, TWO, idAt(ids, 0))).labels).toEqual([
    "e2",
    "e3",
  ]);

  // One past it the oldest is gone, but the id just before the oldest retained one is missing nothing.
  await publishNumbered(publisher, 1, THREE + 1);
  expect((await take(publisher, THREE, idAt(ids, 0))).labels).toEqual([
    "e2",
    "e3",
    "e4",
  ]);

  // Two past it the first id is older than anything retained: it starts from a snapshot.
  await publishNumbered(publisher, 1, THREE + TWO);
  expect((await take(publisher, THREE, idAt(ids, 1))).labels).toEqual([
    "e3",
    "e4",
    "e5",
  ]);
  expect(await firstEvent(publisher, idAt(ids, 0))).toBe("snapshot");
});
