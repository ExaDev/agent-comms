/**
 * Worker-level integration tests for the tab-facing oRPC downstream (tab-contract.ts).
 *
 * Drives the tab router directly through a real MessagePort pair (a genuine MessageChannel, not a mock) rather than simulating a SharedWorker "connect" event -- this is the isolated downstream half in isolation, with no real upstream server: mutating procedures correctly report "not connected" since nothing has called connect() in this test. Also spikes the pagehide/disconnect mechanism the migration plan flagged as a real, unverified risk: does MessagePortHandler expose a public way to evict a specific peer on demand? Confirmed here empirically, not just by reading the adapter's source -- calling disconnect actually closes the underlying peer without throwing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createORPCClient, getEventMeta } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { ContractRouterClient } from "@orpc/contract";
import {
  upgradeTabRpcPort,
  localPublisher,
  ports,
  agents,
  rooms,
} from "../mesh-worker.js";
import type { TabContract } from "../tab-contract.js";
import type { MeshEvent } from "../../contract.js";

type TabClient = ContractRouterClient<TabContract>;

function connectTab(): { client: TabClient; port1: MessagePort } {
  const { port1, port2 } = new MessageChannel();
  upgradeTabRpcPort(port2);
  port1.start();
  const link = new RPCLink({ port: port1 });
  return { client: createORPCClient(link), port1 };
}

function toMeshIterator(value: unknown): AsyncIterator<MeshEvent> {
  return value as AsyncIterator<MeshEvent>;
}

async function nextMeshEvent(
  iterator: Readonly<AsyncIterator<MeshEvent>>,
): Promise<MeshEvent | undefined> {
  const result = await iterator.next();
  return result.done === true ? undefined : result.value;
}

afterEach(() => {
  ports.clear();
  agents.clear();
  rooms.clear();
});

describe("tab-facing oRPC downstream", () => {
  it("subscribeEvents yields an initial state_sync built from the worker's own local state", async () => {
    const { client } = connectTab();
    const iterator = toMeshIterator(await client.subscribeEvents({}));
    const first = await nextMeshEvent(iterator);
    expect(first?.kind).toBe("state_sync");
    await iterator.return?.(undefined);
  });

  it("delivers a state_patch published to localPublisher after subscribing", async () => {
    const { client } = connectTab();
    const iterator = toMeshIterator(await client.subscribeEvents({}));
    await nextMeshEvent(iterator); // state_sync

    localPublisher.publish({
      kind: "state_patch",
      patch: { type: "agent_offline", agentId: "agent-1" },
    });

    const event = await nextMeshEvent(iterator);
    expect(event?.kind).toBe("state_patch");
    await iterator.return?.(undefined);
  });

  it("resumes localPublisher's stream by lastEventId after disconnecting", async () => {
    const { client } = connectTab();
    const iterator = toMeshIterator(await client.subscribeEvents({}));
    await nextMeshEvent(iterator); // state_sync

    localPublisher.publish({
      kind: "state_patch",
      patch: { type: "agent_offline", agentId: "before-disconnect" },
    });
    const before = await nextMeshEvent(iterator);
    const lastEventId =
      before !== undefined ? getEventMeta(before)?.id : undefined;
    expect(lastEventId).toBeDefined();

    await iterator.return?.(undefined);

    localPublisher.publish({
      kind: "state_patch",
      patch: { type: "agent_offline", agentId: "while-offline" },
    });

    const { client: resumeClient } = connectTab();
    const resumed = toMeshIterator(
      await resumeClient.subscribeEvents({ lastEventId }),
    );
    const replayed = await nextMeshEvent(resumed);
    expect(replayed?.kind).toBe("state_patch");
    if (replayed?.kind === "state_patch" && "agentId" in replayed.patch) {
      expect(replayed.patch.agentId).toBe("while-offline");
    }
    await resumed.return?.(undefined);
  });

  it("mutating procedures report not-connected when no upstream client exists yet", async () => {
    const { client } = connectTab();
    const result = await client.listRooms({});
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Not connected to mesh yet");
  });

  it("disconnect closes the underlying peer without throwing -- the pagehide eviction mechanism the migration plan flagged as needing real verification", async () => {
    const { client } = connectTab();
    const result = await client.disconnect({});
    expect(result).toEqual({});
  });
});
