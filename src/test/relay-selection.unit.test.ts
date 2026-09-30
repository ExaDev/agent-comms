/**
 * The relay selection policy (agent-comms#342): a relay on this machine, then one on the local network, then any trusted relay-offering device, then the configured public hub, with deny-by-default trust for every offer not from a machine-local peer.
 */

import { describe, expect, it } from "vitest";
import { selectRelay, type RelayOffer } from "../core/relay-selection.js";

const DEVICE_ID_HEX_LENGTH = 64;
const PUBLIC_HUB = "wss://mesh.example.com/";
const OWN = "0".repeat(DEVICE_ID_HEX_LENGTH);
const MACHINE_PEER = "1".repeat(DEVICE_ID_HEX_LENGTH);
const LAN_PEER = "2".repeat(DEVICE_ID_HEX_LENGTH);
const REMOTE_PEER = "3".repeat(DEVICE_ID_HEX_LENGTH);
const STRANGER = "4".repeat(DEVICE_ID_HEX_LENGTH);

const machineOffer: RelayOffer = {
  deviceHex: MACHINE_PEER,
  addresses: ["ws://127.0.0.1:4100/", "ws://192.168.1.10:4100/"],
  machineLocal: true,
};
const lanOffer: RelayOffer = {
  deviceHex: LAN_PEER,
  addresses: ["ws://127.0.0.1:4200/", "ws://10.0.0.7:4200/"],
  machineLocal: false,
};
const remoteOffer: RelayOffer = {
  deviceHex: REMOTE_PEER,
  addresses: ["wss://relay.example.net/"],
  machineLocal: false,
};

function select(
  offers: readonly RelayOffer[],
  trusted: readonly string[] = [LAN_PEER, REMOTE_PEER],
): ReturnType<typeof selectRelay> {
  return selectRelay({
    offers,
    isTrusted: (hex) => trusted.includes(hex),
    ownDeviceHex: OWN,
    publicHubUrl: PUBLIC_HUB,
  });
}

describe("selectRelay", () => {
  it("prefers a relay on this machine, over its loopback address", () => {
    expect(select([remoteOffer, lanOffer, machineOffer])).toEqual({
      url: "ws://127.0.0.1:4100/",
      tier: "machine",
      deviceHex: MACHINE_PEER,
    });
  });

  it("falls to a trusted relay on the local network next, over its private address", () => {
    expect(select([remoteOffer, lanOffer])).toEqual({
      url: "ws://10.0.0.7:4200/",
      tier: "lan",
      deviceHex: LAN_PEER,
    });
  });

  it("falls to any trusted relay-offering device next", () => {
    expect(select([remoteOffer])).toEqual({
      url: "wss://relay.example.net/",
      tier: "trusted",
      deviceHex: REMOTE_PEER,
    });
  });

  it("falls back to the configured public hub when no offer qualifies", () => {
    expect(select([])).toEqual({ url: PUBLIC_HUB, tier: "public" });
  });

  it("never uses an offer from an untrusted device, however well placed", () => {
    const strangerOffer: RelayOffer = {
      deviceHex: STRANGER,
      addresses: ["ws://192.168.1.99:4300/", "wss://stranger.example.org/"],
      machineLocal: false,
    };

    expect(select([strangerOffer, remoteOffer])).toEqual({
      url: "wss://relay.example.net/",
      tier: "trusted",
      deviceHex: REMOTE_PEER,
    });
    expect(select([strangerOffer])).toEqual({
      url: PUBLIC_HUB,
      tier: "public",
    });
  });

  it("never reaches a device learned through a hub over a loopback address, which would only reach this machine", () => {
    const loopbackOnly: RelayOffer = {
      deviceHex: REMOTE_PEER,
      addresses: ["ws://127.0.0.1:4400/"],
      machineLocal: false,
    };

    expect(select([loopbackOnly])).toEqual({ url: PUBLIC_HUB, tier: "public" });
  });

  it("never relays through this store's own offer", () => {
    expect(select([{ ...machineOffer, deviceHex: OWN }])).toEqual({
      url: PUBLIC_HUB,
      tier: "public",
    });
  });

  it("ignores an address that is not a ws:// or wss:// URL", () => {
    expect(
      select([{ ...remoteOffer, addresses: ["tcp://relay.example.net:9"] }]),
    ).toEqual({ url: PUBLIC_HUB, tier: "public" });
  });

  it("breaks a tie within a tier by lowest device-id, so every store hearing the same offers chooses alike", () => {
    const otherLan: RelayOffer = {
      deviceHex: "1".repeat(DEVICE_ID_HEX_LENGTH),
      addresses: ["ws://192.168.5.5:4500/"],
      machineLocal: false,
    };

    expect(
      select([lanOffer, otherLan], [LAN_PEER, otherLan.deviceHex]).deviceHex,
    ).toBe(otherLan.deviceHex);
  });
});
