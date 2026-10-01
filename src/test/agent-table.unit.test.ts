/**
 * Unit tests for list_agents' aligned table (core/agent-table, agent-comms#345): every column starts at the same offset in every line, header included, however long a name is.
 */

import { describe, expect, it } from "vitest";
import { agentTable, type AgentTableRow } from "../core/agent-table.js";

const DEVICE_ID_HEX_LENGTH = 64;

function row(id: string, name: string): AgentTableRow {
  return {
    id: id.repeat(DEVICE_ID_HEX_LENGTH),
    name,
    harness: "claude-code",
    status: "active",
    visibility: "visible",
    cwd: "~/project",
  };
}

/** Where each of values starts in line, searching from left to right. */
function offsets(line: string, values: readonly string[]): number[] {
  let from = 0;
  return values.map((value) => {
    const at = line.indexOf(value, from);
    from = at + value.length;
    return at;
  });
}

describe("agentTable", () => {
  it("lines every column up under its header, even when one name is far longer than the rest", () => {
    const rows = [
      row("a", "short"),
      row(
        "b",
        `my work laptop ${JSON.stringify("a much longer self-asserted name")}`,
      ),
    ];
    const table = agentTable(rows);
    const header = offsets(table.header, [
      "ID",
      "Name",
      "Harness",
      "Status",
      "Visibility",
      "CWD",
    ]);

    for (const r of rows) {
      expect(
        offsets(table.line(r), [
          r.id,
          r.name,
          r.harness,
          r.status,
          r.visibility,
          r.cwd,
        ]),
      ).toEqual(header);
    }
  });
});
