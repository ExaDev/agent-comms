/**
 * Direct unit tests for mergeKnownDevices, extracted from WireMeshTransport (see gossip-directory.ts's own header) -- previously only exercised indirectly through gossip-directory-aggregation.integration.test.ts's real-session harness.
 */
import { describe, expect, it } from "vitest";
import { mergeKnownDevices } from "../core/gossip-directory.js";
import type { DirectoryEntry } from "wire-mesh-core/domain/mesh-session";
import type { PeerAdvert } from "wire-mesh-core/generated/protocol";
import { syntheticAdvert } from "./synthetic-advert.js";

const DEVICE_ID_HEX_LENGTH = 64;
const DEVICE_A_HEX = "a".repeat(DEVICE_ID_HEX_LENGTH);
const DEVICE_B_HEX = "b".repeat(DEVICE_ID_HEX_LENGTH);
/** An arbitrary "later" snapshot-seconds value, distinct from every other one used in this file's fixtures. */
const NEWER_SNAPSHOT_SECONDS = 5;

function deviceIdBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function advert(snapshotSeconds: number, hex = DEVICE_A_HEX): PeerAdvert {
  return syntheticAdvert(deviceIdBytes(hex), { snapshotSeconds });
}

function entry(hex: string, snapshotSeconds: number): DirectoryEntry {
  return { device: deviceIdBytes(hex), advert: advert(snapshotSeconds, hex) };
}

describe("mergeKnownDevices", () => {
  it("records a device this map has never seen before", () => {
    const knownDevices = new Map<string, PeerAdvert>();

    mergeKnownDevices(knownDevices, [entry(DEVICE_A_HEX, 1)]);

    expect(knownDevices.get(DEVICE_A_HEX)?.["snapshot-seconds"]).toBe(1);
  });

  it("replaces an existing entry with a strictly newer advert", () => {
    const knownDevices = new Map<string, PeerAdvert>([
      [DEVICE_A_HEX, advert(1)],
    ]);

    mergeKnownDevices(knownDevices, [entry(DEVICE_A_HEX, 2)]);

    expect(knownDevices.get(DEVICE_A_HEX)?.["snapshot-seconds"]).toBe(2);
  });

  it("keeps an equal-snapshot advert as the incoming one (>=, not >)", () => {
    const knownDevices = new Map<string, PeerAdvert>([
      [DEVICE_A_HEX, advert(1)],
    ]);
    const incoming = advert(1);

    mergeKnownDevices(knownDevices, [
      { device: deviceIdBytes(DEVICE_A_HEX), advert: incoming },
    ]);

    expect(knownDevices.get(DEVICE_A_HEX)).toBe(incoming);
  });

  it("never regresses an existing entry to an older advert", () => {
    const knownDevices = new Map<string, PeerAdvert>([
      [DEVICE_A_HEX, advert(NEWER_SNAPSHOT_SECONDS)],
    ]);

    mergeKnownDevices(knownDevices, [entry(DEVICE_A_HEX, 1)]);

    expect(knownDevices.get(DEVICE_A_HEX)?.["snapshot-seconds"]).toBe(
      NEWER_SNAPSHOT_SECONDS,
    );
  });

  it("merges multiple distinct devices from the same directory independently", () => {
    const knownDevices = new Map<string, PeerAdvert>();

    mergeKnownDevices(knownDevices, [
      entry(DEVICE_A_HEX, 1),
      entry(DEVICE_B_HEX, 2),
    ]);

    expect(knownDevices.get(DEVICE_A_HEX)?.["snapshot-seconds"]).toBe(1);
    expect(knownDevices.get(DEVICE_B_HEX)?.["snapshot-seconds"]).toBe(2);
  });
});
