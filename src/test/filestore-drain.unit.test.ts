/**
 * FileStore.drainDelivery returns every event it can read: a file that fails to parse is left in place and reported, and the events read before and after it are still returned.
 */
import * as fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileStore } from "../core/store.js";
import type { DeliveryEvent } from "../core/types.js";
import { scratchDirectory } from "./scratch-directory.helper.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function dmEvent(id: string, timestamp: string): DeliveryEvent {
  return {
    type: "dm",
    message: { id, from: "a", to: "b", content: id, timestamp, readBy: [] },
  };
}

it("returns the events on either side of a file that cannot be parsed, and leaves that file where it is", async () => {
  const store = new FileStore(scratchDirectory("agent-comms-drain-"));
  await store.deliver("agent", dmEvent("first", "2026-01-01T00:00:00.000Z"));
  await store.deliver("agent", dmEvent("last", "2026-01-03T00:00:00.000Z"));
  const dir = store.deliveryDir("agent");
  // Sorts between and after the two events' own file names, whatever they are.
  fs.writeFileSync(path.join(dir, "0-damaged.json"), "{ not json");
  fs.writeFileSync(path.join(dir, "zzzz-damaged.json"), '{"type":"unknown"}');
  const written = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const drained = await store.drainDelivery("agent");

  expect(drained.map((e) => (e.type === "dm" ? e.message.id : ""))).toEqual([
    "first",
    "last",
  ]);
  expect(fs.readdirSync(dir).sort()).toEqual([
    "0-damaged.json",
    "zzzz-damaged.json",
  ]);
  const reported = written.mock.calls.map(([chunk]) => String(chunk)).join("");
  expect(reported).toContain("0-damaged.json");
  expect(reported).toContain("zzzz-damaged.json");
});

it("reports a file that stays in place once, however often the queue is drained", async () => {
  const store = new FileStore(scratchDirectory("agent-comms-drain-once-"));
  const dir = store.deliveryDir("agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "poison.json"), "{ not json");
  const written = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  await store.drainDelivery("agent");
  await store.drainDelivery("agent");
  await store.drainDelivery("agent");

  const reports = written.mock.calls
    .map(([chunk]) => String(chunk))
    .filter((line) => line.includes("poison.json"));
  expect(reports).toHaveLength(1);
});

it("returns nothing for an agent with no queue", async () => {
  const store = new FileStore(scratchDirectory("agent-comms-drain-"));
  expect(await store.drainDelivery("nobody")).toEqual([]);
});
