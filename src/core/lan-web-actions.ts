/**
 * The lan_web_uis action's handler, split out of tool.ts to keep that file under the repo's max-lines cap.
 */

import {
  notMeshBacked,
  type CommsResult,
  type MeshOnlyFeatures,
} from "./tool.js";
import { idWithNames, type Namer } from "./naming.js";

/** Lists the LAN web UIs heard as web beacons (agent-comms#353): each as its ready-to-open URL beside the full peer id and its names, since the entry a user acts on is the peer id. */
export function lanWebUisAction(
  store: Readonly<MeshOnlyFeatures>,
  namer: Namer,
): CommsResult {
  if (!store.lanWebUis) return notMeshBacked("lan_web_uis");
  const entries = store.lanWebUis.list();
  if (entries.length === 0) {
    return {
      content:
        "No LAN web UIs heard. A bridge announces its web UI on the local network only while it is bound beyond loopback (AGENT_COMMS_WEB_HOST).",
      isError: false,
    };
  }
  const lines = entries.map(
    (entry) =>
      `http://${entry.host}:${entry.webPort.toString()}  ${idWithNames(entry.peerId, namer)}`,
  );
  return {
    content: `LAN web UIs:\n${lines.join("\n")}`,
    isError: false,
  };
}
