/**
 * The LAN web UIs this machine has heard web beacons for (agent-comms#353): the receiving half of the beacon bridges broadcast when their web server binds beyond loopback, kept as a bounded, expiring table so `lan_web_uis` can list neighbouring dashboards without anything accumulating.
 */

import { FIRST_CONTACT_INTERVAL_MS } from "./first-contact.js";

/** Missed beacon intervals tolerated before an entry expires: the same conventional missed-heartbeat threshold the gossip presence check uses (gossip-extensions.ts's PRESENCE_STALE_MISSED_TICKS), for the same reason -- one dropped and one slow beacon is absorbed, a genuinely departed bridge leaves the list. */
const BEACON_STALE_MISSED_TICKS = 3;

const STALE_AFTER_MS = FIRST_CONTACT_INTERVAL_MS * BEACON_STALE_MISSED_TICKS;

/** One neighbouring web UI as last heard: where it listens, and when. */
export interface LanWebUiEntry {
  peerId: string;
  host: string;
  webPort: number;
  heardAtMs: number;
}

/** The table of LAN web UIs heard on this machine's first-contact presence. An entry is refreshed by every beacon its bridge sends, and a bridge that stops beaconing drops out of `list()` once its entry is stale. */
export class LanWebUis {
  private readonly entries = new Map<string, LanWebUiEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Records (or refreshes) the UI a beacon announced, keyed by peer id so a bridge that restarts on a new port replaces its own entry rather than accumulating one per restart. */
  record(peerId: string, host: string, webPort: number): LanWebUiEntry {
    const entry: LanWebUiEntry = {
      peerId,
      host,
      webPort,
      heardAtMs: this.now(),
    };
    this.entries.set(peerId, entry);
    return entry;
  }

  /** record for a beacon as first contact hands it up, host already taken from the datagram's source address. */
  recordBeacon(
    beacon: Readonly<{ peerId: string; host: string; webPort: number }>,
  ): LanWebUiEntry {
    return this.record(beacon.peerId, beacon.host, beacon.webPort);
  }

  /** Every unexpired entry, ordered by peer id so the listing is stable between calls. */
  list(): readonly Readonly<LanWebUiEntry>[] {
    const cutoff = this.now() - STALE_AFTER_MS;
    for (const [peerId, entry] of this.entries) {
      if (entry.heardAtMs < cutoff) this.entries.delete(peerId);
    }
    return [...this.entries.values()].sort((a, b) =>
      a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0,
    );
  }
}
