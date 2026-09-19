import { describe, expect, it } from "vitest";
import {
  mergeMessageHistories,
  ROOM_TOKEN_LIFETIME_MS,
} from "../core/mesh-store-shared.js";

const DAYS = 30;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

describe("ROOM_TOKEN_LIFETIME_MS", () => {
  it("is exactly 30 days, in milliseconds", () => {
    expect(ROOM_TOKEN_LIFETIME_MS).toBe(
      DAYS *
        HOURS_PER_DAY *
        MINUTES_PER_HOUR *
        SECONDS_PER_MINUTE *
        MS_PER_SECOND,
    );
  });
});

interface TestMessage {
  id: string;
  readBy: string[];
  text?: string;
}

function msg(id: string, readBy: readonly string[] = []): TestMessage {
  return { id, readBy: [...readBy] };
}

describe("mergeMessageHistories", () => {
  it("appends an incoming entry the local list does not have", () => {
    const merged = mergeMessageHistories([msg("a")], [msg("b")]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("appends multiple new entries in incoming order", () => {
    const merged = mergeMessageHistories([msg("a")], [msg("b"), msg("c")]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("preserves local ordering -- new entries are appended, not inserted", () => {
    const merged = mergeMessageHistories([msg("a"), msg("z")], [msg("m")]);
    expect(merged.map((m) => m.id)).toEqual(["a", "z", "m"]);
  });

  it("unions a new reader onto an existing entry's readBy", () => {
    const merged = mergeMessageHistories(
      [msg("a", ["u1"])],
      [msg("a", ["u2"])],
    );
    expect(merged[0]?.readBy.sort()).toEqual(["u1", "u2"]);
  });

  it("does not duplicate a reader already present locally", () => {
    const merged = mergeMessageHistories(
      [msg("a", ["u1"])],
      [msg("a", ["u1"])],
    );
    expect(merged[0]?.readBy).toEqual(["u1"]);
  });

  it("unions several readers from one incoming entry", () => {
    const merged = mergeMessageHistories(
      [msg("a", ["u1"])],
      [msg("a", ["u1", "u2", "u3"])],
    );
    expect(merged[0]?.readBy.sort()).toEqual(["u1", "u2", "u3"]);
  });

  it("leaves an existing entry's readBy untouched when incoming has none", () => {
    const merged = mergeMessageHistories([msg("a", ["u1"])], [msg("a", [])]);
    expect(merged[0]?.readBy).toEqual(["u1"]);
  });

  it("does not grow the merged length for an already-known entry", () => {
    const merged = mergeMessageHistories([msg("a")], [msg("a")]);
    expect(merged).toHaveLength(1);
  });

  it("handles an empty incoming list as a no-op, returning an equivalent copy", () => {
    const merged = mergeMessageHistories([msg("a", ["u1"])], []);
    expect(merged).toEqual([msg("a", ["u1"])]);
  });

  it("handles an empty local list, returning everything incoming", () => {
    const merged = mergeMessageHistories([], [msg("a"), msg("b")]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("merges a mix of new and existing entries in one call", () => {
    const merged = mergeMessageHistories(
      [msg("a", ["u1"]), msg("b", [])],
      [msg("a", ["u2"]), msg("c", ["u3"])],
    );
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged[0]?.readBy.sort()).toEqual(["u1", "u2"]);
    expect(merged[1]?.readBy).toEqual([]);
    expect(merged[2]?.readBy).toEqual(["u3"]);
  });

  it("does not mutate either input array", () => {
    const local = [msg("a", ["u1"])];
    const incoming = [msg("a", ["u2"]), msg("b")];
    mergeMessageHistories(local, incoming);
    expect(local).toEqual([msg("a", ["u1"])]);
    expect(incoming).toEqual([msg("a", ["u2"]), msg("b")]);
  });

  it("does not mutate an existing local entry's own readBy array in place", () => {
    const originalEntry = msg("a", ["u1"]);
    const local = [originalEntry];
    mergeMessageHistories(local, [msg("a", ["u2"])]);
    // The merged result's entry for "a" must be a distinct object/array from the one still referenced by the caller's own original local list -- otherwise a caller holding onto its own pre-merge array would see readers silently appear in it too.
    expect(originalEntry.readBy).toEqual(["u1"]);
  });

  it("unions two same-id entries within one incoming batch into a single merged entry, not a duplicate", () => {
    // A brand-new id appearing twice in the same incoming batch is the one case where the freshly-added entry must be looked up again within the same call, not just against local's own pre-existing entries -- proves the id-to-entry index is kept in sync as new entries are added mid-merge, not only seeded from local up front.
    const merged = mergeMessageHistories(
      [],
      [msg("a", ["u1"]), msg("a", ["u2"])],
    );
    expect(merged.map((m) => m.id)).toEqual(["a"]);
    expect(merged[0]?.readBy.sort()).toEqual(["u1", "u2"]);
  });
});
