// One-off live smoke check: two real WireMeshTransport instances in this process, both dialling the production hub (wss://mesh.exadev.io/), discovering each other via the hub's gossip, and exchanging a message through a relay pairing. Run with: npx tsx scripts/hub-smoke-check.ts

import { generateIdentity } from "../src/core/identity.js";
import { WireMeshTransport } from "../src/core/wire-mesh-transport.js";
import { GatewayTrust } from "../src/core/gateway-trust.js";
import type { TransportEvents } from "../src/core/transport.js";

const HUB_URL = "wss://mesh.exadev.io/";
const DISCOVERY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
const SHUTDOWN_GRACE_MS = 500;

function inertEvents(onMessage: TransportEvents["onMessage"]): TransportEvents {
  return {
    onMessage,
    onPeerConnected: () => undefined,
    onPeerDisconnected: () => undefined,
    onIntroduction: () => undefined,
    onConnectionRequest: () => undefined,
    onPeerList: () => undefined,
    onPeerJoined: () => undefined,
    onBecomeCoordinator: () => undefined,
    onRevocationAnnounce: () => undefined,
    onPresenceAdvert: () => undefined,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  let received = "";
  let receivedFrom = "";
  const eventsA = inertEvents(() => undefined);
  const eventsB = inertEvents((handle, message) => {
    if (message.method === "peer_joined") {
      received = message.peer.id;
      receivedFrom = handle.id;
    }
  });

  const trustA = new GatewayTrust();
  const trustB = new GatewayTrust();
  const transportA = new WireMeshTransport(
    eventsA,
    generateIdentity(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    trustA,
  );
  const transportB = new WireMeshTransport(
    eventsB,
    generateIdentity(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    trustB,
  );

  // GatewayTrust defaults to deny-all when a caller wires none in (see WireMeshTransport's own constructor doc comment). Without mutual trust here, HubSession's directory-merge drops each side's gossiped entry from the other before either transport's peers() list ever reflects it, so discovery below would never succeed.
  const deviceA = await transportA.hub.ownDeviceHex();
  const deviceB = await transportB.hub.ownDeviceHex();
  trustA.add(deviceB);
  trustB.add(deviceA);

  console.log("connecting both agents to the production hub...");
  await transportA.hub.connect(HUB_URL);
  await transportB.hub.connect(HUB_URL);
  console.log("both connected; waiting for mutual gossip discovery...");

  const started = Date.now();
  while (Date.now() - started < DISCOVERY_TIMEOUT_MS) {
    if (
      transportA.hub.peers().includes(deviceB) &&
      transportB.hub.peers().includes(deviceA)
    ) {
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const aSeesB = transportA.hub.peers().includes(deviceB);
  const bSeesA = transportB.hub.peers().includes(deviceA);
  console.log(
    `discovery: a-sees-b=${String(aSeesB)} b-sees-a=${String(bSeesA)}`,
  );
  if (!aSeesB || !bSeesA) {
    throw new Error("mutual discovery did not happen within the timeout");
  }

  console.log("sending a message from A to B through the relay pairing...");
  await transportA.hub.sendToPeer(deviceB, {
    method: "peer_joined",
    peer: {
      id: "hub-smoke-payload",
      port: 0,
      startedAt: "2026-01-01T00:00:00.000Z",
    },
  });

  const sendStarted = Date.now();
  while (received === "" && Date.now() - sendStarted < DISCOVERY_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
  }
  if (received !== "hub-smoke-payload") {
    throw new Error("B never received the relayed message within the timeout");
  }
  console.log(
    `B received the message from ${receivedFrom} (expected ${deviceA})`,
  );
  if (receivedFrom !== deviceA) {
    throw new Error("message attributed to the wrong sender");
  }

  await transportA.shutdown();
  await transportB.shutdown();
  await sleep(SHUTDOWN_GRACE_MS);
  console.log(
    "PASS: two agents discovered each other and exchanged a message through the production hub",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(
      "FAIL:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
