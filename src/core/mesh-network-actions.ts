/**
 * CommsTool's mesh discovery/advertise/interfaces/listener/visibility action handlers -- split out of tool.ts purely to keep that file under the repo's max-lines cap, the same reason gateway-trust-actions.ts/mesh-graph-trace-tool.ts were split from it. Free functions over an explicit DiscoveryManager/CommsStore pair rather than class methods, since CommsTool owns no state of its own for this concern.
 */

import type { CommsAction, NetworkInterface } from "./types.js";
import type { ListenerInfo } from "./transport.js";
import type { DiscoveryManager } from "./discovery.js";
import type { CommsResult, MeshOnlyFeatures } from "./tool.js";
import { notMeshBacked, tryMeshAction } from "./tool.js";

/** Table column widths for the plain-text listing helpers below, matching tool.ts's own aligned-column convention for every other tabular action result. */
const INTERFACE_NAME_COLUMN_WIDTH = 12;
const INTERFACE_FAMILY_COLUMN_WIDTH = 4;
const LISTENER_HOST_COLUMN_WIDTH = 15;
const LISTENER_PORT_COLUMN_WIDTH = 6;
const LISTENER_POLICY_COLUMN_WIDTH = 11;

/** Default port the mesh coordinator listens on when advertising with no explicit port given. */
const DEFAULT_MESH_COORDINATOR_PORT = 19876;

export async function meshDiscoverAction(
  discovery: DiscoveryManager | undefined,
  action: CommsAction & { action: "mesh_discover" },
): Promise<CommsResult> {
  if (!discovery) {
    return {
      content: "Discovery is not available (no backends registered).",
      isError: true,
    };
  }
  const meshes = await discovery.discover(action.method);
  if (meshes.length === 0) {
    return { content: "No meshes discovered.", isError: false };
  }
  const lines = meshes.map(
    (m) =>
      `  ${m.host}:${String(m.port)}  ${m.name}${m.agentCount !== undefined ? ` (${String(m.agentCount)} agents)` : ""}`,
  );
  return {
    content: `Discovered meshes:\n${lines.join("\n")}`,
    isError: false,
  };
}

export async function meshAdvertiseAction(
  discovery: DiscoveryManager | undefined,
  action: CommsAction & { action: "mesh_advertise" },
): Promise<CommsResult> {
  if (!discovery) {
    return {
      content: "Discovery is not available (no backends registered).",
      isError: true,
    };
  }
  const port = action.port ?? DEFAULT_MESH_COORDINATOR_PORT;
  const opts: { name: string; port: number; adapter?: string } = {
    name: action.name,
    port,
  };
  if (action.adapter !== undefined) opts.adapter = action.adapter;
  const id = await discovery.advertise(action.method, opts);
  return {
    content: `Advertising mesh "${action.name}" on ${action.method} (port ${String(port)}). ID: ${id}`,
    isError: false,
  };
}

export function meshInterfacesAction(
  store: Readonly<Pick<MeshOnlyFeatures, "getNetworkInterfaces">>,
): CommsResult {
  if (!store.getNetworkInterfaces) return notMeshBacked("mesh_interfaces");
  const interfaces = store.getNetworkInterfaces();
  if (interfaces.length === 0)
    return { content: "No network interfaces found.", isError: false };

  const lines = interfaces.map((iface: Readonly<NetworkInterface>) => {
    const internal = iface.internal ? " (internal)" : "";
    return `${iface.name.padEnd(INTERFACE_NAME_COLUMN_WIDTH)} ${iface.family.padEnd(INTERFACE_FAMILY_COLUMN_WIDTH)} ${iface.address}${internal}`;
  });
  return {
    content: `Interfaces:\n${lines.join("\n")}`,
    isError: false,
  };
}

export async function meshUnadvertiseAction(
  discovery: DiscoveryManager | undefined,
  action: CommsAction & { action: "mesh_unadvertise" },
): Promise<CommsResult> {
  if (!discovery) {
    return {
      content: "Discovery is not available (no backends registered).",
      isError: true,
    };
  }
  await discovery.stopAdvertising(action.id);
  return { content: `Stopped advertising ${action.id}.`, isError: false };
}

export async function meshListenAction(
  store: Readonly<Pick<MeshOnlyFeatures, "addListener">>,
  action: CommsAction & { action: "mesh_listen" },
): Promise<CommsResult> {
  const policy = action.policy ?? "full";
  const validPolicies = ["full", "observe", "rooms-only", "gateway"];
  if (!validPolicies.includes(policy)) {
    return {
      content: `Invalid policy "${policy}". Must be one of: ${validPolicies.join(", ")}`,
      isError: true,
    };
  }
  if (!store.addListener) return notMeshBacked("mesh_listen");
  const addListener = store.addListener.bind(store);
  return tryMeshAction("add listener", async () => {
    const id = await addListener(action.host, action.port ?? 0, policy);
    return `Listener added: ${id} on ${action.host}${String(action.port ?? "auto")} with policy ${policy}.`;
  });
}

export async function meshUnlistenAction(
  store: Readonly<Pick<MeshOnlyFeatures, "removeListener">>,
  action: CommsAction & { action: "mesh_unlisten" },
): Promise<CommsResult> {
  if (!store.removeListener) return notMeshBacked("mesh_unlisten");
  const removeListener = store.removeListener.bind(store);
  return tryMeshAction("remove listener", async () => {
    await removeListener(action.id);
    return `Listener ${action.id} removed.`;
  });
}

export function meshListenersAction(
  store: Readonly<Pick<MeshOnlyFeatures, "listListeners">>,
): CommsResult {
  if (!store.listListeners) return notMeshBacked("mesh_listeners");
  const listeners = store.listListeners();
  if (listeners.length === 0)
    return { content: "No listeners (not coordinator).", isError: false };

  const lines = listeners.map((l: Readonly<ListenerInfo>) => {
    const flag = l.isDefault ? " (default)" : "";
    return `${l.id}  ${l.host.padEnd(LISTENER_HOST_COLUMN_WIDTH)} ${String(l.port).padEnd(LISTENER_PORT_COLUMN_WIDTH)} ${l.policy.padEnd(LISTENER_POLICY_COLUMN_WIDTH)}${flag}`;
  });
  return {
    content: `Listeners:\n  ID      Host             Port   Policy      \n${lines.map((l) => `  ${l}`).join("\n")}`,
    isError: false,
  };
}

export async function meshSetVisibilityAction(
  store: Readonly<Pick<MeshOnlyFeatures, "setVisibility">>,
  action: CommsAction & { action: "mesh_set_visibility" },
): Promise<CommsResult> {
  if (!store.setVisibility) {
    return {
      content: "Visibility control is not available on this store.",
      isError: true,
    };
  }
  await store.setVisibility(action.visibility, action.adapter);
  const adapter =
    action.adapter !== undefined ? ` on adapter "${action.adapter}"` : "";
  return {
    content: `Mesh visibility set to "${action.visibility}"${adapter}.`,
    isError: false,
  };
}

export function meshGetVisibilityAction(
  store: Readonly<Pick<MeshOnlyFeatures, "getVisibility">>,
): CommsResult {
  if (!store.getVisibility) {
    return {
      content: "Visibility control is not available on this store.",
      isError: true,
    };
  }
  const visibility = store.getVisibility();
  return {
    content: `Mesh visibility: ${visibility}`,
    isError: false,
  };
}
