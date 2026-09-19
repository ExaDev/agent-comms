/**
 * Plain action functions -- one per browser-facing action, extracted from server.ts's executeAction switch so both the legacy /api/action REST dispatcher and the new oRPC router call the same implementation instead of two copies drifting apart.
 *
 * Each function preserves executeAction's exact prior validation behaviour (empty string treated the same as missing) even though the oRPC contract's own Zod schemas already enforce presence and type -- the contract validates shape, these functions still validate the same business rules the REST path has always enforced.
 */

import type { PushManager } from "../../../core/push-manager.js";
import type { PushSubscription } from "../../../core/web-push.js";
import type { ChatController } from "../controller.js";
import type { ActionResult } from "./contract.js";

export async function sendAction(
  controller: ChatController,
  input: Readonly<{ target: string; content: string }>,
): Promise<ActionResult> {
  if (input.target === "" || input.content === "") {
    return { content: "Missing target or content", isError: true };
  }
  return controller.send(input.target, input.content);
}

export async function dmAction(
  controller: ChatController,
  input: Readonly<{ target: string; content: string }>,
): Promise<ActionResult> {
  if (input.target === "" || input.content === "") {
    return { content: "Missing target or content", isError: true };
  }
  return controller.dm(input.target, input.content);
}

export async function joinRoomAction(
  controller: ChatController,
  input: Readonly<{ room: string }>,
): Promise<ActionResult> {
  if (input.room === "") return { content: "Missing room", isError: true };
  const result = await controller.switchRoom(input.room);
  if (!result.isError) {
    const msgs = await controller.readRoom();
    return { content: `${result.content}\n${msgs.content}`, isError: false };
  }
  return result;
}

export async function leaveRoomAction(
  controller: ChatController,
  input: Readonly<{ room?: string | undefined }>,
): Promise<ActionResult> {
  return controller.leaveRoom(input.room);
}

export async function createRoomAction(
  controller: ChatController,
  input: Readonly<{
    name: string;
    type: "public" | "private" | "secret";
    description?: string | undefined;
  }>,
): Promise<ActionResult> {
  if (input.name === "") return { content: "Missing name", isError: true };
  return controller.createRoom(input.name, {
    type: input.type,
    description: input.description ?? "",
  });
}

export async function listRoomsAction(
  controller: ChatController,
): Promise<ActionResult> {
  return controller.listRooms();
}

export async function listAgentsAction(
  controller: ChatController,
): Promise<ActionResult> {
  return controller.listAgents();
}

export async function readRoomAction(
  controller: ChatController,
  input: Readonly<{ room?: string | undefined }>,
): Promise<ActionResult> {
  return controller.readRoom({ roomId: input.room });
}

export async function destroyRoomAction(
  controller: ChatController,
  input: Readonly<{ room: string }>,
): Promise<ActionResult> {
  if (input.room === "") return { content: "Missing room", isError: true };
  return controller.destroyRoom(input.room);
}

export async function inviteAction(
  controller: ChatController,
  input: Readonly<{ room: string; agent: string }>,
): Promise<ActionResult> {
  if (input.room === "" || input.agent === "") {
    return { content: "Missing room or agent", isError: true };
  }
  return controller.invite(input.room, input.agent);
}

export async function declineInviteAction(
  controller: ChatController,
  input: Readonly<{ room: string; reason: string }>,
): Promise<ActionResult> {
  if (input.room === "" || input.reason === "") {
    return { content: "Missing room or reason", isError: true };
  }
  return controller.declineInvite(input.room, input.reason);
}

export async function kickAction(
  controller: ChatController,
  input: Readonly<{ room: string; agent: string }>,
): Promise<ActionResult> {
  if (input.room === "" || input.agent === "") {
    return { content: "Missing room or agent", isError: true };
  }
  return controller.kick(input.room, input.agent);
}

export async function renameAgentAction(
  controller: ChatController,
  input: Readonly<{ agent: string; name: string }>,
): Promise<ActionResult> {
  if (input.agent === "" || input.name === "") {
    return { content: "Missing agent or name", isError: true };
  }
  return controller.renameAgent(input.agent, input.name);
}

function isPushSubscription(value: unknown): value is PushSubscription {
  if (typeof value !== "object" || value === null) return false;
  if (!("endpoint" in value) || typeof value.endpoint !== "string")
    return false;
  if (!("keys" in value)) return false;
  const keys = value.keys;
  if (typeof keys !== "object" || keys === null) return false;
  if (!("p256dh" in keys) || typeof keys.p256dh !== "string") return false;
  if (!("auth" in keys) || typeof keys.auth !== "string") return false;
  return true;
}

export function pushSubscribeAction(
  controller: ChatController,
  pushManager: PushManager | undefined,
  input: Readonly<{ subscription: unknown; agentId?: string | undefined }>,
): ActionResult {
  if (!pushManager) {
    return { content: "Push notifications unavailable", isError: true };
  }
  if (!isPushSubscription(input.subscription)) {
    return { content: "Invalid push subscription", isError: true };
  }
  const agentId = input.agentId ?? controller.agentId;
  pushManager.addSubscription(agentId, input.subscription);
  return { content: "Push subscription registered", isError: false };
}

export function pushUnsubscribeAction(
  controller: ChatController,
  pushManager: PushManager | undefined,
  input: Readonly<{ agentId?: string | undefined }>,
): ActionResult {
  if (!pushManager) {
    return { content: "Push notifications unavailable", isError: true };
  }
  const agentId = input.agentId ?? controller.agentId;
  pushManager.removeSubscription(agentId);
  return { content: "Push subscription removed", isError: false };
}
