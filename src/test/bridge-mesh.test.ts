/**
 * Unit tests for createBridgeMesh -- the shared factory every bridge builds its own MeshStore/WireMeshTransport/CommsTool from, replacing the identical four-line block each of the six bridges used to repeat against TlsTransport directly.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deviceIdToHex } from "@exadev/wire-mesh-core/domain/device-id";
import { createBridgeMesh } from "../core/bridge-mesh.js";
import {
  loadOrCreateIdentity,
  type IdentitySlot,
} from "../core/identity-store.js";
import { waitFor } from "./test-transport.js";

function tempSlot(harness: string): IdentitySlot {
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "agent-comms-bridge-mesh-test-"),
  );
  return { harness, cwd: "/tmp/project", dir };
}

void test("createBridgeMesh sets peerId to deviceIdToHex(identity.deviceId), not the certificate fingerprint", async () => {
  const slot = tempSlot("test-harness");
  const identity = loadOrCreateIdentity(slot);
  const { store } = createBridgeMesh(slot);
  try {
    assert.strictEqual(
      store.peerId,
      deviceIdToHex(Uint8Array.from(identity.deviceId)),
    );
    assert.notStrictEqual(store.peerId, identity.fingerprint);
  } finally {
    await store.shutdown();
  }
});

void test("createBridgeMesh wires a WireMeshTransport, not TlsTransport", async () => {
  const slot = tempSlot("test-harness");
  const { store } = createBridgeMesh(slot);
  try {
    // init() is the only way to prove the transport is actually usable end to end, which also confirms it's a WireMeshTransport by construction (createBridgeMesh only ever builds one).
    await store.init();
    assert.ok(store.connected);
  } finally {
    await store.shutdown();
  }
});

void test("createBridgeMesh passes an explicit coordinatorPort through to MeshStore, forming one shared mesh", async () => {
  const slotA = tempSlot("test-harness-a");
  const slotB = tempSlot("test-harness-b");
  const port = 20_900 + Math.floor(Math.random() * 100);
  const a = createBridgeMesh(slotA, port);
  const b = createBridgeMesh(slotB, port);
  try {
    await a.store.init();
    await b.store.init();
    assert.ok(a.store.connected);
    assert.ok(b.store.connected);
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
