/**
 * Client state — minimal observable state for the UI.
 *
 * No DOM dependency. Testable in isolation.
 * Consumers subscribe to changes and re-render as needed.
 */

import type { Agent, DisplayMessage, MeshGraph, Room } from "./types.js";

export type StateChangeListener = (state: Readonly<ClientState>) => void;

export interface ClientState {
  currentRoom: string | undefined;
  dmTarget: string | undefined;
  agents: readonly Agent[];
  rooms: readonly Room[];
  messages: readonly DisplayMessage[];
  connected: boolean;
  /** The mesh's connection graph (agent-comms#199/#201), refreshed on the same WS-driven triggers as agents/rooms. Undefined until the first successful fetch, or when this bridge isn't mesh-backed. */
  meshGraph: MeshGraph | undefined;
}

const INITIAL_STATE: ClientState = {
  currentRoom: undefined,
  dmTarget: undefined,
  agents: [],
  rooms: [],
  messages: [],
  connected: false,
  meshGraph: undefined,
};

export class State {
  private state: ClientState = { ...INITIAL_STATE };
  private readonly listeners = new Set<StateChangeListener>();

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Read the current state (shallow copy). */
  get(): Readonly<ClientState> {
    return this.state;
  }

  // -----------------------------------------------------------------------
  // Mutations — each notifies listeners
  // -----------------------------------------------------------------------

  setCurrentRoom(roomId: string | undefined): void {
    this.state = { ...this.state, currentRoom: roomId };
    this.notify();
  }

  setDmTarget(agentId: string | undefined): void {
    this.state = { ...this.state, dmTarget: agentId };
    this.notify();
  }

  setAgents(agents: readonly Agent[]): void {
    this.state = { ...this.state, agents };
    this.notify();
  }

  setRooms(rooms: readonly Room[]): void {
    this.state = { ...this.state, rooms };
    this.notify();
  }

  setConnected(connected: boolean): void {
    this.state = { ...this.state, connected };
    this.notify();
  }

  setMeshGraph(meshGraph: MeshGraph): void {
    this.state = { ...this.state, meshGraph };
    this.notify();
  }

  /** Add a display message to the message list. */
  addMessage(message: DisplayMessage): void {
    this.state = { ...this.state, messages: [...this.state.messages, message] };
    this.notify();
  }

  /** Replace all messages (e.g. when loading history). */
  setMessages(messages: readonly DisplayMessage[]): void {
    this.state = { ...this.state, messages };
    this.notify();
  }

  /** Clear all messages. */
  clearMessages(): void {
    this.state = { ...this.state, messages: [] };
    this.notify();
  }

  /** Bulk update from a state frame (initial WS connection). */
  applyState(agents: readonly Agent[], rooms: readonly Room[]): void {
    this.state = { ...this.state, agents, rooms };
    this.notify();
  }

  /** Reset to initial state. */
  reset(): void {
    this.state = { ...INITIAL_STATE, messages: [] };
    this.notify();
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private notify(): void {
    const snapshot = this.state;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
