/**
 * Gap detection for the account ledger's logs: a log that stays behind an announced head for three rounds is reported once, and asked for from every source that announced it; it is not reported when the heads agree, when it catches up, or when the announcing sources have gone.
 */

import { describe, expect, it } from "vitest";
import { bytesToHex } from "wire-mesh-core/domain/device-id";
import type { DataRequestFrame } from "wire-mesh-core/generated/protocol";
import { LEDGER_STALL_ROUNDS, LedgerGapTracker } from "../core/ledger-gaps.js";

/** Two writer log ids, as the wire carries them: 32 bytes in real use, short here. */
const LOG = Uint8Array.from(Buffer.from("01020304", "hex"));
const LOG_HEX = bytesToHex(LOG);
const OTHER_LOG = Uint8Array.from(Buffer.from("09090909", "hex"));
const ANNOUNCED_HEAD = 5;
const LARGER_HEAD = 8;
const STALLED_EXTRA_ROUNDS = 4;
const STALLED_GAP_START = 2;
const REPEATS = 3;

function tracker(live: ReadonlySet<string> = new Set(["relay", "direct"])) {
  const requests: { source: string; frame: DataRequestFrame }[] = [];
  const errors: Error[] = [];
  const gaps = new LedgerGapTracker({
    request: async (source, frame) => {
      requests.push({ source, frame });
    },
    isLive: (source) => live.has(source),
    onError: (error) => {
      errors.push(error);
    },
  });
  return { gaps, requests, errors, live };
}

async function rounds(
  gaps: LedgerGapTracker,
  count: number,
  localHeads: ReadonlyMap<string, number> = new Map(),
): Promise<void> {
  for (let round = 0; round < count; round += 1) {
    await gaps.round(localHeads);
  }
}

describe("a log behind an announced head", () => {
  it("is not reported before the third round", async () => {
    const { gaps, errors, requests } = tracker();
    gaps.noteHave("relay", LOG, ANNOUNCED_HEAD);

    await rounds(gaps, LEDGER_STALL_ROUNDS - 1);

    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
    expect(gaps.stalled()).toEqual([]);
  });

  it("is reported once after three rounds with no new entry, and listed as stalled", async () => {
    const { gaps, errors } = tracker();
    gaps.noteHave("relay", LOG, ANNOUNCED_HEAD);

    await rounds(gaps, LEDGER_STALL_ROUNDS + STALLED_EXTRA_ROUNDS);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain(LOG_HEX);
    expect(errors[0]?.message).toContain("revocation");
    expect(gaps.stalled()).toEqual([
      {
        log: LOG_HEX,
        localHead: 0,
        announcedHead: ANNOUNCED_HEAD,
        rounds: LEDGER_STALL_ROUNDS + STALLED_EXTRA_ROUNDS,
      },
    ]);
  });

  it("is reported again only when the gap grows", async () => {
    const { gaps, errors } = tracker();
    gaps.noteHave("relay", LOG, ANNOUNCED_HEAD);
    await rounds(gaps, LEDGER_STALL_ROUNDS);

    gaps.noteHave("relay", LOG, ANNOUNCED_HEAD);
    await rounds(gaps, 2);
    expect(errors).toHaveLength(1);

    gaps.noteHave("relay", LOG, LARGER_HEAD);
    await rounds(gaps, 1);
    expect(errors).toHaveLength(2);
  });

  it("is asked for from every source that announced a higher head, from the local head, and not from one at or below it", async () => {
    const { gaps, requests } = tracker(new Set(["relay", "direct", "behind"]));
    const local = new Map([[LOG_HEX, STALLED_GAP_START]]);
    gaps.noteHave("relay", LOG, ANNOUNCED_HEAD);
    gaps.noteHave("direct", LOG, ANNOUNCED_HEAD);
    gaps.noteHave("behind", LOG, STALLED_GAP_START);

    await rounds(gaps, LEDGER_STALL_ROUNDS, local);

    expect(requests.map((r) => r.source).sort()).toEqual(["direct", "relay"]);
    for (const { frame } of requests) {
      expect(frame).toEqual({
        type: "data-request",
        peer: LOG,
        "from-seq": STALLED_GAP_START,
      });
    }
  });

  it("asks a second source for the entries the first never sent, and the stall clears when they arrive", async () => {
    const { gaps, requests, errors } = tracker();
    gaps.noteHave("relay", LOG, ANNOUNCED_HEAD);
    await rounds(gaps, LEDGER_STALL_ROUNDS);
    expect(errors).toHaveLength(1);
    expect(gaps.stalled()).toHaveLength(1);

    gaps.noteHave("direct", LOG, ANNOUNCED_HEAD);
    await gaps.round(new Map());
    expect(requests.map((r) => r.source)).toContain("direct");

    await gaps.round(new Map([[LOG_HEX, ANNOUNCED_HEAD]]));
    expect(gaps.stalled()).toEqual([]);
  });

  it("restarts its count when a new entry arrives, even while still behind", async () => {
    const { gaps, errors } = tracker();
    gaps.noteHave("relay", LOG, LARGER_HEAD);

    await gaps.round(new Map([[LOG_HEX, 1]]));
    await gaps.round(new Map([[LOG_HEX, 1]]));
    await gaps.round(new Map([[LOG_HEX, 2]]));
    await gaps.round(new Map([[LOG_HEX, 2]]));

    expect(errors).toEqual([]);
  });
});

describe("a log that is not behind", () => {
  it("is never reported when the heads agree, however many rounds pass", async () => {
    const { gaps, errors, requests } = tracker();
    gaps.noteHave("relay", LOG, ANNOUNCED_HEAD);

    await rounds(
      gaps,
      LEDGER_STALL_ROUNDS * REPEATS,
      new Map([[LOG_HEX, ANNOUNCED_HEAD]]),
    );

    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
    expect(gaps.stalled()).toEqual([]);
  });

  it("is never reported when this side is ahead", async () => {
    const { gaps, errors } = tracker();
    gaps.noteHave("relay", LOG, 1);

    await rounds(
      gaps,
      LEDGER_STALL_ROUNDS * REPEATS,
      new Map([[LOG_HEX, ANNOUNCED_HEAD]]),
    );

    expect(errors).toEqual([]);
  });

  it("is forgotten once the only source that announced it is gone", async () => {
    const live = new Set(["relay"]);
    const { gaps, errors } = tracker(live);
    gaps.noteHave("relay", LOG, ANNOUNCED_HEAD);
    await rounds(gaps, LEDGER_STALL_ROUNDS - 1);

    live.delete("relay");
    await rounds(gaps, LEDGER_STALL_ROUNDS);

    expect(errors).toEqual([]);
    expect(gaps.stalled()).toEqual([]);
  });

  it("is tracked independently of another log", async () => {
    const { gaps, errors } = tracker();
    gaps.noteHave("relay", LOG, ANNOUNCED_HEAD);
    gaps.noteHave("relay", OTHER_LOG, ANNOUNCED_HEAD);

    await rounds(
      gaps,
      LEDGER_STALL_ROUNDS,
      new Map([[bytesToHex(OTHER_LOG), ANNOUNCED_HEAD]]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain(LOG_HEX);
    expect(errors[0]?.message).not.toContain(bytesToHex(OTHER_LOG));
  });
});

describe("a request that fails", () => {
  it("is reported and does not stop the request to another source", async () => {
    const errors: Error[] = [];
    const sent: string[] = [];
    const gaps = new LedgerGapTracker({
      request: async (source) => {
        if (source === "relay") throw new Error("no route");
        sent.push(source);
      },
      isLive: () => true,
      onError: (error) => {
        errors.push(error);
      },
    });
    gaps.noteHave("relay", LOG, ANNOUNCED_HEAD);
    gaps.noteHave("direct", LOG, ANNOUNCED_HEAD);

    await rounds(gaps, LEDGER_STALL_ROUNDS);

    expect(sent).toEqual(["direct"]);
    expect(errors.map((e) => e.message)).toContain("no route");
  });
});
