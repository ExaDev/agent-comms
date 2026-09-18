/**
 * Entry point — bootstraps the web UI with React + Mantine.
 *
 * Owns the state store, WebSocket connection, and action handlers. The Root component subscribes to state changes via useClientState and re-renders reactively; this file itself stays a plain imperative shell around that one component, same as before the framework swap.
 */

import mantineStyles from "@mantine/core/styles.css?inline";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { App } from "./components/App.js";
import { parseInput, routeAction } from "./input.js";
import { State } from "./state.js";
import { useClientState } from "./use-client-state.js";
import { MeshClient } from "./mesh-client.js";
import { theme } from "./theme.js";
import type { Action, DisplayMessage } from "./types.js";

import { isLocalHost, hasConnectedBefore } from "./boot-logic.js";

const mantineStyleEl = document.createElement("style");
mantineStyleEl.textContent = mantineStyles;
document.head.appendChild(mantineStyleEl);

/** Whether the page is served from a local mesh server (vs standalone PWA). */
const isLocalServer = isLocalHost(location.host);
import { deliveryEventToMessage, roomMessageToDisplay } from "./messages.js";
import { parseDeepLink, resolveDeepLink, syncUrl } from "./url-sync.js";

// ---------------------------------------------------------------------------
// Mount point
// ---------------------------------------------------------------------------

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("missing #root element");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = new State();

/** Backs the three structured one-shot reads (agent-comms#206) -- getRoomMessages/getMeshGraph/getMeshTrace, via meshClient.queryUtils. */
const queryClient = new QueryClient();

// ---------------------------------------------------------------------------
// Mesh client — real-time state via SharedWorker
// ---------------------------------------------------------------------------

const meshClient = new MeshClient();

let wasConnected = false;

meshClient.subscribe((meshState) => {
  // agents/rooms are already fully real-time via subscribeEvents' state_sync/state_patch stream (agent-comms#206) -- no REST re-fetch needed on top of this.
  if (meshState.agents.length > 0) {
    state.setAgents(meshState.agents);
  }
  if (meshState.rooms.length > 0) {
    state.setRooms(meshState.rooms);
  }
  state.setConnected(meshState.connected);

  if (meshState.connected !== wasConnected) {
    wasConnected = meshState.connected;
    addMessage({
      type: "system",
      text: meshState.connected
        ? "Connected to mesh"
        : "Disconnected — reconnecting...",
    });
  }
});

meshClient.onDelivery((event) => {
  const msg = deliveryEventToMessage(event, state.get().currentRoom);
  if (msg) addMessage(msg);

  if (
    event.type === "member_joined" ||
    event.type === "member_left" ||
    event.type === "member_status" ||
    event.type === "name_changed"
  ) {
    void invalidateMeshGraph();
  }
});

// Don't auto-connect the MeshClient on first load. The user must explicitly connect to avoid Chrome's "access device" prompt appearing before the user understands the UI. meshClient.connect() is called from onConnectToMesh().

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addMessage(msg: DisplayMessage): void {
  state.addMessage(msg);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function sendAction(action: Action): Promise<void> {
  const result = await meshClient.sendAction(action);
  addMessage({
    type: result.isError ? "status" : "system",
    text: result.isError ? `Error: ${result.content}` : result.content,
  });
  if (!result.isError) {
    void invalidateMeshGraph();
  }
}

/** Invalidates the mesh graph query on the same triggers a REST refresh used to run on (agent-comms#201/#206) -- a failure here (most commonly this bridge running on a FileStore rather than a real mesh transport, so mesh_graph simply isn't supported) is left to whatever's already subscribed to the query to surface, the same way any other failed refetch would. */
async function invalidateMeshGraph(): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: meshClient.queryUtils.getMeshGraph.key(),
  });
}

async function onJoinRoom(roomId: string): Promise<void> {
  state.setDmTarget(undefined);
  state.setCurrentRoom(roomId);
  state.clearMessages();

  void sendAction({ action: "join_room", room: roomId });

  // Room history now goes through the same tab-worker-server oRPC channel every other read does (agent-comms#206), so it works uniformly whether this is served from the local server or probing for one as a standalone PWA -- unlike the REST fetch it replaces, which only ever worked in the local-server case.
  const messages = await queryClient.query(
    meshClient.queryUtils.getRoomMessages.queryOptions({
      input: { room: roomId },
    }),
  );
  state.setMessages(messages.map(roomMessageToDisplay));
  addMessage({ type: "system", text: `Joined ${roomId}` });
}

function onSelectAgent(agentId: string): void {
  state.setCurrentRoom(undefined);
  state.setDmTarget(agentId);
  state.clearMessages();
}

function onLeaveRoom(): void {
  const s = state.get();
  const currentRoom = s.currentRoom;
  if (currentRoom !== undefined && currentRoom !== "") {
    // currentRoom is the room's real owner-qualified id -- resolve it back to the plain name it was created with for the confirmation message, the same way ChatArea's own header resolves it for display.
    const roomName =
      s.rooms.find((room) => room.id === currentRoom)?.name ?? currentRoom;
    void sendAction({ action: "leave_room", room: currentRoom });
    state.setCurrentRoom(undefined);
    state.clearMessages();
    addMessage({ type: "system", text: `Left room "${roomName}"` });
  }
}

function handleSendAction(text: string): void {
  const s = state.get();
  const result = parseInput(text, s.currentRoom, s.dmTarget);

  // Check if this action needs local client-side handling
  const localRoute = routeAction(result);
  if (localRoute) {
    switch (localRoute.kind) {
      case "join_room":
        void onJoinRoom(localRoute.room);
        return;
      case "leave_room":
        onLeaveRoom();
        return;
    }
  }

  switch (result.kind) {
    case "action":
      void sendAction(result.action);
      break;
    case "local":
      addMessage({ type: "system", text: result.result.text });
      break;
    case "ignored":
      break;
  }
}

function onCreateRoom(
  name: string,
  type: "public" | "private" | "secret",
  description: string,
): void {
  const action: Action = {
    action: "create_room",
    name,
    type,
    ...(description ? { description } : {}),
  };
  void sendAction(action);
}

function onJoinRoomInput(roomName: string): void {
  void onJoinRoom(roomName);
}

function onRenameAgent(agentId: string, newName: string): void {
  void sendAction({ action: "rename_agent", agent: agentId, name: newName });
}

function onConnectToMesh(): void {
  localStorage.setItem("agent-comms-connected", "true");
  meshClient.connect();
}

// ---------------------------------------------------------------------------
// Root — subscribes to state and keeps the URL in sync
// ---------------------------------------------------------------------------

function Root() {
  const s = useClientState(state);

  useEffect(() => {
    syncUrl({ currentRoom: s.currentRoom, dmTarget: s.dmTarget });
  }, [s.currentRoom, s.dmTarget]);

  return (
    <App
      rooms={s.rooms}
      agents={s.agents}
      currentRoom={s.currentRoom}
      dmTarget={s.dmTarget}
      messages={s.messages}
      connected={s.connected}
      queryUtils={meshClient.queryUtils}
      onJoinRoom={(roomId) => {
        void onJoinRoom(roomId);
      }}
      onSelectAgent={onSelectAgent}
      onRenameAgent={onRenameAgent}
      onLeaveRoom={onLeaveRoom}
      onSendAction={handleSendAction}
      onCreateRoom={onCreateRoom}
      onJoinRoomInput={onJoinRoomInput}
      onConnectToMesh={onConnectToMesh}
    />
  );
}

createRoot(rootEl).render(
  <QueryClientProvider client={queryClient}>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Root />
    </MantineProvider>
  </QueryClientProvider>,
);

// Capture the deep link from the URL BEFORE syncUrl's first run clears the query parameters via replaceState, which would make location.search empty by the time parseDeepLink runs.
const deepLink = parseDeepLink(location.search);

// Auto-connect when served from local server, or when the user has connected before. First-time visitors to the standalone PWA see a connect prompt instead of Chrome's unexpected "access device" permission prompt.
const previouslyConnected = hasConnectedBefore(localStorage);
if (isLocalServer || previouslyConnected) {
  meshClient.connect();
}

// Resolve any deep link from the URL once the real-time room list first arrives (agent-comms#206 -- agents/rooms are already fully covered by the live subscribeEvents stream, so this no longer waits on a separate REST fetch the way it used to). A one-shot subscriber, unsubscribing itself the moment it has a non-empty room list to resolve against.
if (deepLink) {
  const unsubscribeDeepLink = meshClient.subscribe((meshState) => {
    if (meshState.rooms.length === 0) return;
    unsubscribeDeepLink();
    const resolved = resolveDeepLink(deepLink, meshState.rooms);
    if (!resolved) return;

    switch (resolved.kind) {
      case "room":
        void onJoinRoom(resolved.targetId);
        break;
      case "dm":
        onSelectAgent(resolved.targetId);
        break;
    }
  });
}
