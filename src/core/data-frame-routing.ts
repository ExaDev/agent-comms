/**
 * data-frame-routing -- WireMeshTransport's own core/data frame dispatch (data-have/data-request/data-entries), split out under the repo's max-lines cap the same way gossip-directory.ts/hub-forwarding.ts were each split from the same owning file.
 */

import {
  handleDataEntries,
  handleDataHave,
  handleDataRequest,
} from "wire-mesh-core/domain/data-sync";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { Frame } from "wire-mesh-core/generated/protocol";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";

const DATA_ENTRIES_RESPONSE_LIMIT = 100;

/** Routes one frame received on a raw data connection to wire-mesh-core's own core/data handlers, tracking the connection against its peer's device-id along the way (connectionsByPeer, mutated in place) so a later data-have/data-request/data-entries send addressed to that same peer reuses it. A no-op past the connectionsByPeer update when dataStorage is unset (this side doesn't participate in core/data at all) or the sender isn't yet a tracked peer session -- mirrors WireMeshTransport's own pre-extraction guard clauses exactly. Any handler error is reported via onError and swallowed, never thrown, since this runs inside the transport's own onFrame callback with no caller awaiting it directly. */
export async function routeDataFrame(
  deps: Readonly<{
    connectionsByPeer: Map<string, Readonly<Connection>>;
    dataStorage: KeyValueStorage | undefined;
    peerSessions: ReadonlyMap<string, unknown>;
    onError: ((error: Error) => void) | undefined;
  }>,
  connection: Readonly<Connection>,
  frame: Frame,
): Promise<void> {
  const peerDeviceId = connection.peerDeviceId;
  if (peerDeviceId === undefined) return;
  const deviceIdHex = deviceIdToHex(peerDeviceId);
  deps.connectionsByPeer.set(deviceIdHex, connection);
  if (deps.dataStorage === undefined) return;
  if (!deps.peerSessions.has(deviceIdHex)) return;
  try {
    if (frame.type === "data-have") {
      const request = await handleDataHave(deps.dataStorage, frame);
      if (request !== null) await connection.send(request);
    } else if (frame.type === "data-request") {
      const entries = await handleDataRequest(
        deps.dataStorage,
        frame,
        DATA_ENTRIES_RESPONSE_LIMIT,
      );
      if (entries !== null) await connection.send(entries);
    } else if (frame.type === "data-entries") {
      await handleDataEntries(deps.dataStorage, frame);
    }
  } catch (error: unknown) {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}
