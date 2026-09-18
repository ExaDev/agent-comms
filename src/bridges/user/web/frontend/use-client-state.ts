/**
 * Bridges the plain State class (subscribe/get) into React via useSyncExternalStore, React's built-in primitive for exactly this shape of external store.
 */

import { useSyncExternalStore } from "react";
import type { State, ClientState } from "./state.js";

export function useClientState(state: State): Readonly<ClientState> {
  return useSyncExternalStore(
    (onChange) => state.subscribe(onChange),
    () => state.get(),
  );
}
