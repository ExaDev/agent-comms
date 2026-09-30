/**
 * Plain read functions -- one per structured one-shot read (agent-comms#206), extracted so both the REST handlers in server.ts and the new oRPC procedures in router.ts call the same implementation instead of two copies drifting apart, the same de-duplication actions.ts already established for mutations.
 *
 * Deliberately excludes agents/rooms: those are already fully covered by subscribeEvents' state_sync/state_patch stream (router.ts), so there is no REST-vs-oRPC pair to de-duplicate for them.
 */

import type { RoomMessage } from "../../../core/types.js";
import type { ChatController } from "../controller.js";
import type { DisplayNameParts } from "../../../core/display-name.js";
import type { MeshGraph, MeshTraceResult } from "./contract.js";

export async function getRoomMessagesRead(
  controller: ChatController,
  input: Readonly<{ room: string; since?: string | undefined }>,
): Promise<RoomMessage[]> {
  return controller.getRoomMessages(input.room, input.since);
}

export function getMeshGraphRead(controller: ChatController): MeshGraph {
  return controller.meshStore.meshGraph();
}

/** Every id this bridge's viewer has a name for (a petname or a known self name), for the dashboard to label ids by the shared display convention (agent-comms#345). */
export async function getDisplayNamesRead(
  controller: ChatController,
): Promise<DisplayNameParts[]> {
  return controller.meshStore.naming.nameParts(controller.agentId);
}

export async function getMeshTraceRead(
  controller: ChatController,
  input: Readonly<{ target: string; timeoutMs?: number | undefined }>,
): Promise<MeshTraceResult> {
  return controller.meshStore.meshTrace(input.target, input.timeoutMs);
}
