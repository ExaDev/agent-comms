/**
 * oRPC router -- implements meshContract against a real ChatController.
 *
 * Every mutating procedure is a one-line passthrough to the plain action functions in actions.ts, the same functions the legacy REST /api/action dispatcher calls, so both paths share one implementation. subscribeEvents is the one genuinely new procedure: it unifies the old chat socket's delivery frames and the old mesh socket's state_sync/state_update methods into a single resumable stream, backed by a per-handle MeshEventPublisher.
 */

import { implement } from "@orpc/server";
import type { PushManager } from "../../../core/push-manager.js";
import type { ChatController } from "../controller.js";
import {
  createRoomAction,
  declineInviteAction,
  destroyRoomAction,
  dmAction,
  inviteAction,
  joinRoomAction,
  kickAction,
  leaveRoomAction,
  listAgentsAction,
  listRoomsAction,
  pushSubscribeAction,
  pushUnsubscribeAction,
  readRoomAction,
  renameAgentAction,
  sendAction,
} from "./actions.js";
import { meshContract } from "./contract.js";
import type { SerialisedState } from "./contract.js";
import type { MeshEventPublisher } from "./event-publisher.js";
import {
  getMeshGraphRead,
  getMeshTraceRead,
  getRoomMessagesRead,
} from "./reads.js";

export interface MeshRouterContext {
  controller: ChatController;
  publisher: MeshEventPublisher;
  pushManager: PushManager | undefined;
}

/** Drops deliveryQueues -- mesh-internal replay state for offline agents, not something a browser tab needs to see -- from a MeshStore snapshot before it goes out as a state_sync event. */
function toBrowserState(state: {
  agents: SerialisedState["agents"];
  rooms: SerialisedState["rooms"];
  messages: SerialisedState["messages"];
  dms: SerialisedState["dms"];
}): SerialisedState {
  return {
    agents: state.agents,
    rooms: state.rooms,
    messages: state.messages,
    dms: state.dms,
  };
}

const impl = implement(meshContract).$context<MeshRouterContext>();

export const meshRouter = {
  send: impl.send.handler(async ({ context, input }) =>
    sendAction(context.controller, input),
  ),

  dm: impl.dm.handler(async ({ context, input }) =>
    dmAction(context.controller, input),
  ),

  joinRoom: impl.joinRoom.handler(async ({ context, input }) =>
    joinRoomAction(context.controller, input),
  ),

  leaveRoom: impl.leaveRoom.handler(async ({ context, input }) =>
    leaveRoomAction(context.controller, input),
  ),

  createRoom: impl.createRoom.handler(async ({ context, input }) =>
    createRoomAction(context.controller, input),
  ),

  listRooms: impl.listRooms.handler(async ({ context }) =>
    listRoomsAction(context.controller),
  ),

  listAgents: impl.listAgents.handler(async ({ context }) =>
    listAgentsAction(context.controller),
  ),

  readRoom: impl.readRoom.handler(async ({ context, input }) =>
    readRoomAction(context.controller, input),
  ),

  destroyRoom: impl.destroyRoom.handler(async ({ context, input }) =>
    destroyRoomAction(context.controller, input),
  ),

  invite: impl.invite.handler(async ({ context, input }) =>
    inviteAction(context.controller, input),
  ),

  declineInvite: impl.declineInvite.handler(async ({ context, input }) =>
    declineInviteAction(context.controller, input),
  ),

  kick: impl.kick.handler(async ({ context, input }) =>
    kickAction(context.controller, input),
  ),

  renameAgent: impl.renameAgent.handler(async ({ context, input }) =>
    renameAgentAction(context.controller, input),
  ),

  pushSubscribe: impl.pushSubscribe.handler(async ({ context, input }) =>
    pushSubscribeAction(context.controller, context.pushManager, input),
  ),

  pushUnsubscribe: impl.pushUnsubscribe.handler(async ({ context, input }) =>
    pushUnsubscribeAction(context.controller, context.pushManager, input),
  ),

  getRoomMessages: impl.getRoomMessages.handler(async ({ context, input }) =>
    getRoomMessagesRead(context.controller, input),
  ),

  getMeshGraph: impl.getMeshGraph.handler(({ context }) =>
    getMeshGraphRead(context.controller),
  ),

  getMeshTrace: impl.getMeshTrace.handler(async ({ context, input }) =>
    getMeshTraceRead(context.controller, input),
  ),

  subscribeEvents: impl.subscribeEvents.handler(async function* ({
    context,
    input,
    signal,
    lastEventId,
  }) {
    // lastEventId is set two ways: oRPC's own RetryLinkPlugin threads it automatically on a mid-stream reconnect (the protocol-level `lastEventId` above); a tab that reconnects from cold (a fresh subscribeEvents call, e.g. after being closed and reopened) has to pass it explicitly as input instead, since there's no in-flight call for the protocol layer to resume.
    const resumeFrom = lastEventId ?? input.lastEventId;

    if (resumeFrom === undefined) {
      yield {
        kind: "state_sync" as const,
        state: toBrowserState(context.controller.meshStore.serialise()),
      };
    }

    yield* context.publisher.subscribe({
      ...(signal ? { signal } : {}),
      ...(resumeFrom !== undefined ? { lastEventId: resumeFrom } : {}),
    });
  }),
};
