/**
 * LanWebUis (agent-comms#353): the bounded, expiring table of LAN web UIs heard as web beacons, and the lan_web_uis action's formatting over it.
 */

import { describe, expect, it } from "vitest";
import { LanWebUis } from "../core/lan-web-uis.js";
import { lanWebUisAction } from "../core/lan-web-actions.js";
import { plainNamer } from "../core/naming.js";
import { FIRST_CONTACT_INTERVAL_MS } from "../core/first-contact.js";
import type { CommsResult } from "../core/tool.js";

/** Two web ports a beacon could announce, distinct from each other and from a restart's new port so every replacement is visible. */
const WEB_PORT_ONE = 55213;
const WEB_PORT_TWO = 55214;
const WEB_PORT_RESTARTED = 55299;

/** Tick spacing between two records, so a later record visibly refreshes heardAtMs. */
const TICKS_BETWEEN_RECORDS = 10_000;

/** The clock's starting tick; any value would do, fixed so heardAtMs is predictable. */
const CLOCK_START_MS = 1_000;

/** Enough missed beacon intervals that an entry must be stale: comfortably past the expiry the table derives from three. */
const STALE_MISSED_BEACONS = 10;
const STALE_AFTER_TICKS = STALE_MISSED_BEACONS * FIRST_CONTACT_INTERVAL_MS;

const PEER_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PEER_C =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

describe("LanWebUis", () => {
  it("lists entries ordered by peer id", () => {
    const table = new LanWebUis(() => CLOCK_START_MS);
    table.record(PEER_C, "192.168.1.6", WEB_PORT_ONE);
    table.record(PEER_B, "192.168.1.5", WEB_PORT_TWO);

    expect(table.list().map((entry) => entry.peerId)).toEqual([PEER_B, PEER_C]);
  });

  it("replaces a peer's entry when its bridge restarts on a new port", () => {
    let now = CLOCK_START_MS;
    const table = new LanWebUis(() => now);
    table.record(PEER_B, "192.168.1.5", WEB_PORT_ONE);
    now += TICKS_BETWEEN_RECORDS;
    table.record(PEER_B, "192.168.1.5", WEB_PORT_RESTARTED);

    expect(table.list()).toEqual([
      {
        peerId: PEER_B,
        host: "192.168.1.5",
        webPort: WEB_PORT_RESTARTED,
        heardAtMs: CLOCK_START_MS + TICKS_BETWEEN_RECORDS,
      },
    ]);
  });

  it("drops an entry once its bridge has missed a few beacon intervals", () => {
    let now = CLOCK_START_MS;
    const table = new LanWebUis(() => now);
    table.record(PEER_B, "192.168.1.5", WEB_PORT_ONE);
    table.record(PEER_C, "192.168.1.6", WEB_PORT_TWO);

    // Peer B goes quiet while peer C keeps beaconing: only B's entry is stale.
    now += STALE_AFTER_TICKS;
    table.record(PEER_C, "192.168.1.6", WEB_PORT_TWO);

    expect(table.list().map((entry) => entry.peerId)).toEqual([PEER_C]);
  });
});

describe("lanWebUisAction", () => {
  it("formats each entry as its URL beside the full peer id and its names", () => {
    const table = new LanWebUis(() => CLOCK_START_MS);
    table.record(PEER_B, "192.168.1.5", WEB_PORT_ONE);
    const result: CommsResult = lanWebUisAction(
      { lanWebUis: table },
      plainNamer,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe(
      `LAN web UIs:\nhttp://192.168.1.5:${WEB_PORT_ONE.toString()}  ${PEER_B}`,
    );
  });

  it("says what absence means rather than an empty list", () => {
    const result = lanWebUisAction({ lanWebUis: new LanWebUis() }, plainNamer);
    expect(result.content).toContain("No LAN web UIs heard");
  });

  it("answers not-mesh-backed when the store has no lanWebUis at all", () => {
    const result = lanWebUisAction({}, plainNamer);
    expect(result.content).toContain("requires a mesh-backed store");
  });
});
