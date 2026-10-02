/**
 * The list_agents listing's formatting, split out of tool.ts to keep that file under the repo's max-lines cap: the table, the per-agent describe block with rooms and versions, and the machine grouping.
 */

import type { Namer } from "./naming.js";
import { detailsShared } from "./agent-registry.js";
import { groupAgentsByMachine } from "./machine-list-groups.js";
import { agentTable, type AgentTableRow } from "./agent-table.js";
import {
  formatListedAgentVersions,
  type VersionReportStore,
} from "./version-report-actions.js";
import type { CommsResult } from "./tool.js";
import type { AgentIdentity } from "./types.js";
import type { AgentDetailsExchange } from "./agent-details.js";

/** What the renderer needs beyond the agents themselves: who is asking, their namer, and the store's optional reads (versions, machines, and the agent-details exchange's cache). */
export interface AgentListFormatStore extends Readonly<
  Pick<
    VersionReportStore,
    | "getPeerAgentCommsVersion"
    | "getPeerWireMeshCoreVersion"
    | "getPeerCcPeerVersion"
  >
> {
  getCcPeerVersion?: (() => string | undefined) | undefined;
  getMachineId?: (() => string | undefined) | undefined;
  listAgentMachines?: (() => Promise<Map<string, string>>) | undefined;
  agentDetailsExchange?: Readonly<Pick<AgentDetailsExchange, "cached">>;
}

/** Renders the whole listing. A trusted remote agent's fetched details (agent-comms#323) stand in for the ones a hub session withholds; a fetch that has not come back yet keeps its not-shared listing until the next call. */
export async function renderAgentList(
  agents: readonly Readonly<AgentIdentity>[],
  opts: Readonly<{
    selfId: string;
    namer: Namer;
    store: Readonly<AgentListFormatStore>;
  }>,
): Promise<CommsResult> {
  const homedir = process.env.HOME ?? "";
  const abbreviateCwd = (cwd: string): string =>
    homedir && cwd.startsWith(homedir) ? `~${cwd.slice(homedir.length)}` : cwd;

  // The full id is printed in its own column, so the name column carries the names alone.
  const rowOf = (a: Readonly<AgentIdentity>): AgentTableRow => {
    const asked = opts.store.agentDetailsExchange?.cached(a.id);
    const shared = detailsShared(a) || asked !== undefined;
    return {
      id: a.id,
      name: opts.namer(a.id, { selfName: a.name, besideFullId: true }),
      harness: a.harness,
      status: a.status,
      visibility: a.visibility,
      cwd: `${shared ? abbreviateCwd(asked?.cwd ?? a.cwd) : "(not shared)"}${a.id === opts.selfId ? " (you)" : ""}`,
    };
  };
  const table = agentTable(agents.map(rowOf));
  const describe = (a: Readonly<AgentIdentity>): string => {
    const isSelf = a.id === opts.selfId;
    const asked = opts.store.agentDetailsExchange?.cached(a.id);
    const shared = detailsShared(a) || asked !== undefined;
    const roomPaths =
      asked === undefined ? a.subscribedRooms : asked.rooms.map((r) => r.path);
    const rooms = !shared
      ? "not shared"
      : roomPaths.length > 0
        ? roomPaths.join(", ")
        : "none";
    const versions = formatListedAgentVersions(
      opts.store,
      a.id,
      isSelf,
      opts.store.getCcPeerVersion,
    );
    return `${table.line(rowOf(a))}\n        Rooms: ${rooms}\n        Versions: ${versions}`;
  };
  const machines = await opts.store.listAgentMachines?.();
  const groups = groupAgentsByMachine(
    agents,
    machines,
    opts.store.getMachineId?.(),
    opts.namer,
  );
  const body = groups
    .map((group) => {
      const rows = group.agents.map((a) => `  ${describe(a)}`);
      return group.heading === undefined
        ? rows.join("\n")
        : [`  ${group.heading}`, ...rows].join("\n");
    })
    .join("\n");
  return {
    content: `Agents:\n  ${table.header}\n${body}`,
    isError: false,
  };
}
