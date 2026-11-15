/**
 * A healthy mesh reports nothing as refused: every store sends the stores it joins only what they may take, so a refusal means a peer that is not conforming, and an operator who sees one is not seeing the noise of an ordinary join.
 */

import { expect, test } from "vitest";
import { createBridgeMesh } from "../core/bridge-mesh.js";
import type { IdentitySlot } from "../core/identity-store.js";
import { freeLocalPort } from "./hub-helpers.js";
import { scratchDirectory } from "./scratch-directory.helper.js";
import { waitFor } from "./test-transport.js";

const STORES = 3;

function tempSlot(harness: string): IdentitySlot {
  const dir = scratchDirectory("agent-comms-state-intake-");
  return { harness, cwd: "/tmp/project", dir };
}

test("three stores joining one mesh each learn the others and report no refusal", async () => {
  const port = await freeLocalPort();
  const reports: string[] = [];
  const meshes: Awaited<ReturnType<typeof createBridgeMesh>>[] = [];
  for (let index = 0; index < STORES; index++) {
    const mesh = await createBridgeMesh(tempSlot(`intake-${String(index)}`), {
      coordinatorPort: port,
      firstContactPort: await freeLocalPort(),
    });
    mesh.store.onError = (error) => {
      reports.push(error.message);
    };
    meshes.push(mesh);
  }
  try {
    // Each store joins a mesh that already holds the agents of the stores before it, so the stores it dials have foreign agents to give it.
    for (const [index, mesh] of meshes.entries()) {
      await mesh.store.init();
      await mesh.store.registerAgent({
        name: `member-${String(index)}`,
        harness: "test",
        cwd: "/tmp/project",
        pid: process.pid,
        visibility: "visible",
        tags: [],
      });
      await waitFor(
        () =>
          meshes
            .slice(0, index + 1)
            .every(
              (joined) =>
                Object.keys(joined.store.serialise().agents).length ===
                index + 1,
            ),
        `the ${String(index + 1)} stores so far hold each other's agents`,
      );
    }

    await waitFor(
      () =>
        meshes.every(
          (mesh) =>
            Object.keys(mesh.store.serialise().agents).length === STORES,
        ),
      "every store holds the agents of all three stores",
    );

    expect(reports.filter((report) => report.includes("refused"))).toEqual([]);
  } finally {
    for (const mesh of meshes.reverse()) await mesh.store.shutdown();
  }
});
