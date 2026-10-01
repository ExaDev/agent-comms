/**
 * Which dashboard queries go stale when the mesh changes, and the invalidation that refreshes them (agent-comms#206, agent-comms#345). The mesh panel draws the connection graph and labels its nodes with display names, two separate one-shot reads, so every trigger that can change either refreshes both: a label left on the old name while the graph moves on is as stale as the other way round.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { MeshClient } from "./mesh-client.js";
import type { DeliveryEvent } from "./types.js";

/** Delivery events after which the graph or a display name may have changed: membership and status change the graph, name_changed changes a label. */
const MESH_VIEW_EVENT_TYPES: ReadonlySet<DeliveryEvent["type"]> = new Set([
  "member_joined",
  "member_left",
  "member_status",
  "name_changed",
]);

/** Whether a delivery event of this type can leave the mesh views stale. */
export function staleAfter(eventType: DeliveryEvent["type"]): boolean {
  return MESH_VIEW_EVENT_TYPES.has(eventType);
}

/** Invalidates the mesh graph and the display names that label it, so whatever is subscribed to either refetches. A refetch that fails (most commonly a bridge on a FileStore, which has no mesh graph) is left to its subscriber to surface, like any other failed query. */
export async function invalidateMeshViews(
  queryClient: QueryClient,
  queryUtils: Pick<
    MeshClient["queryUtils"],
    "getMeshGraph" | "getDisplayNames"
  >,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryUtils.getMeshGraph.key(),
    }),
    queryClient.invalidateQueries({
      queryKey: queryUtils.getDisplayNames.key(),
    }),
  ]);
}
