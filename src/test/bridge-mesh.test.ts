/**
 * Unit tests for createBridgeMesh -- the shared factory every bridge builds its own MeshStore/WireMeshTransport/CommsTool from, replacing the identical four-line block each of the six bridges used to repeat against TlsTransport directly.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "vitest";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { createBridgeMesh } from "../core/bridge-mesh.js";
import {
  loadOrCreateIdentity,
  type IdentitySlot,
} from "../core/identity-store.js";
import { waitFor } from "./test-transport.js";

// Base of the ephemeral coordinator-port range used to avoid colliding with the mesh's real well-known port.
const TEST_COORDINATOR_PORT_BASE = 20_900;
// Width of the randomised offset added to TEST_COORDINATOR_PORT_BASE so concurrent test runs don't collide on the same port.
const TEST_COORDINATOR_PORT_RANGE = 100;

function tempSlot(harness: string): IdentitySlot {
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "agent-comms-bridge-mesh-test-"),
  );
  return { harness, cwd: "/tmp/project", dir };
}

test("createBridgeMesh sets peerId to deviceIdToHex(identity.deviceId), not the certificate fingerprint", async () => {
  const slot = tempSlot("test-harness");
  const identity = loadOrCreateIdentity(slot);
  const { store } = await createBridgeMesh(slot);
  try {
    expect(store.peerId).toBe(
      deviceIdToHex(Uint8Array.from(identity.deviceId)),
    );
    expect(store.peerId).not.toBe(identity.fingerprint);
  } finally {
    await store.shutdown();
  }
});

test("createBridgeMesh wires a WireMeshTransport", async () => {
  const slot = tempSlot("test-harness");
  const { store } = await createBridgeMesh(slot);
  try {
    // init() is the only way to prove the transport is actually usable end to end, which also confirms it's a WireMeshTransport by construction (createBridgeMesh only ever builds one).
    await store.init();
    expect(store.connected).toBeTruthy();
  } finally {
    await store.shutdown();
  }
});

test("createBridgeMesh passes an explicit coordinatorPort through to MeshStore, forming one shared mesh", async () => {
  const slotA = tempSlot("test-harness-a");
  const slotB = tempSlot("test-harness-b");
  const port =
    TEST_COORDINATOR_PORT_BASE +
    Math.floor(Math.random() * TEST_COORDINATOR_PORT_RANGE);
  const a = await createBridgeMesh(slotA, port);
  const b = await createBridgeMesh(slotB, port);
  try {
    await a.store.init();
    await b.store.init();
    expect(a.store.connected).toBeTruthy();
    expect(b.store.connected).toBeTruthy();
    await a.store.registerAgent({
      name: "peer-a",
      harness: "test-harness-a",
      cwd: "/tmp/project",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    await waitFor(
      () => b.store.serialise().agents[a.store.peerId] !== undefined,
      "b sees a's agent, proving both joined the same mesh on the shared coordinatorPort",
    );
  } finally {
    await b.store.shutdown();
    await a.store.shutdown();
  }
});
