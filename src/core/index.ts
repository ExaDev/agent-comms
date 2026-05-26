/**
 * Agent Comms — cross-harness LLM agent communication.
 *
 * Core protocol: types, store interface, tool handler.
 * Bridges (pi extension, Claude Code channel) are in ../bridges/.
 */

export type { CommsStore } from "./comms-store.js";
export { FileStore, CommsError } from "./store.js";
export { MeshStore } from "./mesh-store.js";
export { CommsTool } from "./tool.js";
export type { CommsContext, CommsResult } from "./tool.js";
export {
  buildAction,
  formatDeliveryEvent,
  isActionableEvent,
  ensureRegistered,
  ensureProjectRoom,
  drainAndFormat,
  MCP_TOOL_PARAMS,
} from "./bridge.js";
export type { RegistrationResult } from "./bridge.js";
export { generateVapidKeys } from "./vapid.js";
export type { VapidKeys } from "./vapid.js";
export { PushManager } from "./push-manager.js";
export type { PushSubscription, PushPayload } from "./push-manager.js";
export { DiscoveryManager } from "./discovery.js";
export type {
  DiscoveredMesh,
  DiscoveryBackend,
  AdvertiseOptions,
} from "./discovery.js";
export { MdnsDiscoveryBackend } from "./discovery-mdns.js";
export { TailscaleDiscoveryBackend } from "./discovery-tailscale.js";
export * from "./types.js";
