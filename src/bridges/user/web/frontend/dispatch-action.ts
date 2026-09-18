/**
 * Maps a legacy flat action object (`{action: "send", target, content}`, matching the browser Action union in types.ts) onto a call against the matching named oRPC procedure.
 *
 * Generic over any client built from a contract that includes meshContract's own 13 action procedures -- both mesh-worker.ts's upstream client (MeshOrpcClient, built from the real server's meshContract) and mesh-client.ts's own client (built from tab-contract.ts's TabContract, which spreads meshContract's procedures verbatim) satisfy this structurally, so the same mapping serves both call sites instead of being hand-duplicated a second time.
 */

import type { ContractRouterClient } from "@orpc/contract";
import type { meshContract, ActionResult } from "../contract.js";

export type ActionDispatchClient = Pick<
  ContractRouterClient<typeof meshContract>,
  | "send"
  | "dm"
  | "joinRoom"
  | "leaveRoom"
  | "createRoom"
  | "listRooms"
  | "listAgents"
  | "readRoom"
  | "destroyRoom"
  | "invite"
  | "declineInvite"
  | "kick"
  | "renameAgent"
  | "pushSubscribe"
  | "pushUnsubscribe"
>;

/** The exact subscription shape meshContract's pushSubscribe procedure requires -- mirrors actions.ts's own server-side isPushSubscription guard, since a flat action object's `subscription` field arrives as unknown here too. */
function isPushSubscriptionLike(
  value: unknown,
): value is { endpoint: string; keys: { p256dh: string; auth: string } } {
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

export async function dispatchAction(
  client: Readonly<ActionDispatchClient>,
  action: Readonly<Record<string, unknown>>,
): Promise<ActionResult> {
  const str = (key: string): string => {
    const value = action[key];
    return typeof value === "string" ? value : "";
  };
  const optStr = (key: string): string | undefined => {
    const value = action[key];
    return typeof value === "string" ? value : undefined;
  };
  const roomType = (): "public" | "private" | "secret" => {
    const value = action.type;
    return value === "public" || value === "private" || value === "secret"
      ? value
      : "public";
  };

  switch (action.action) {
    case "send":
      return client.send({ target: str("target"), content: str("content") });
    case "dm":
      return client.dm({ target: str("target"), content: str("content") });
    case "join_room":
      return client.joinRoom({ room: str("room") });
    case "leave_room":
      return client.leaveRoom({ room: optStr("room") });
    case "create_room":
      return client.createRoom({
        name: str("name"),
        type: roomType(),
        description: optStr("description"),
      });
    case "list_rooms":
      return client.listRooms({});
    case "list_agents":
      return client.listAgents({});
    case "read_room":
      return client.readRoom({ room: optStr("room") });
    case "destroy_room":
      return client.destroyRoom({ room: str("room") });
    case "invite":
      return client.invite({ room: str("room"), agent: str("agent") });
    case "decline_invite":
      return client.declineInvite({
        room: str("room"),
        reason: str("reason"),
      });
    case "kick":
      return client.kick({ room: str("room"), agent: str("agent") });
    case "rename_agent":
      return client.renameAgent({ agent: str("agent"), name: str("name") });
    case "push_subscribe": {
      const subscription = action.subscription;
      if (!isPushSubscriptionLike(subscription)) {
        return { content: "Invalid push subscription", isError: true };
      }
      return client.pushSubscribe({ subscription, agentId: optStr("agentId") });
    }
    case "push_unsubscribe":
      return client.pushUnsubscribe({ agentId: optStr("agentId") });
    default:
      return {
        content: `Unknown action: ${String(action.action)}`,
        isError: true,
      };
  }
}
