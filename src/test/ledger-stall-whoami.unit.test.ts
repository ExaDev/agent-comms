/**
 * What whoami says about account ledger logs this side has stayed behind: one line per log, in a fixed wording, no more than a fixed number of them, and none when nothing is behind.
 */

import { describe, expect, it } from "vitest";
import { buildAction } from "../core/bridge.js";
import { MeshStore } from "../core/mesh-store.js";
import type { StalledLedgerLog } from "../core/ledger-gaps.js";
import { CommsTool } from "../core/tool.js";
import { wireTestTransport } from "./test-transport.js";

const SHOWN = 8;
const LOG_COUNT = 20;
const HEX_RADIX = 16;
const LOG_ID_HEX_DIGITS = 8;
const HEAD_AHEAD = 5;

function stalledLog(index: number): StalledLedgerLog {
  return {
    log: index.toString(HEX_RADIX).padStart(LOG_ID_HEX_DIGITS, "0"),
    localHead: index,
    announcedHead: index + HEAD_AHEAD,
    rounds: 3,
  };
}

async function whoamiWith(
  stalled: readonly StalledLedgerLog[],
): Promise<string> {
  const store = new MeshStore();
  await wireTestTransport(store);
  const agent = await store.registerAgent({
    name: "owner",
    harness: "pi",
    cwd: "/tmp/p",
    pid: process.pid,
    visibility: "visible",
    tags: [],
  });
  const tool = new CommsTool(store, { getStalledLedgerLogs: () => stalled });
  const result = await tool.handle(
    { agentId: agent.id, harness: "pi", cwd: "/tmp/p", pid: process.pid },
    buildAction({ action: "whoami" }),
  );
  expect(result.isError).toBe(false);

  return result.content;
}

describe("whoami and the account ledger", () => {
  it("says nothing about the ledger when no log is behind", async () => {
    expect(await whoamiWith([])).not.toContain("Account ledger");
  });

  it("names a log that is behind, in a fixed wording", async () => {
    const content = await whoamiWith([stalledLog(1)]);

    expect(content.split("\n")).toContain(
      "Account ledger log 00000001 is behind: this machine holds up to entry 1, a peer announces 6, and 3 rounds have passed without the missing entries arriving; a grant or a revocation in them is not applied here",
    );
  });

  it("prints at most a fixed number of logs and counts the rest", async () => {
    const content = await whoamiWith(
      Array.from({ length: LOG_COUNT }, (_, index) => stalledLog(index)),
    );

    const lines = content.split("\n");
    expect(
      lines.filter((line) => line.startsWith("Account ledger log ")),
    ).toHaveLength(SHOWN);
    expect(lines).toContain(
      `Account ledger: ${String(LOG_COUNT - SHOWN)} more logs are behind`,
    );
  });
});
