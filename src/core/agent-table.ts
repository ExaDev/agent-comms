/**
 * list_agents' aligned table (agent-comms#345). Every column but the last is as wide as its widest cell, header included, so the columns stay lined up under the header whatever the names are: a petname beside a quoted self name can be far longer than a bare registered name used to be, and a fixed width let one long name push every later column out of line.
 */

/** One agent's cells, in column order. cwd is last and so never padded. */
export interface AgentTableRow {
  id: string;
  name: string;
  harness: string;
  status: string;
  visibility: string;
  cwd: string;
}

const HEADER: Readonly<AgentTableRow> = {
  id: "ID",
  name: "Name",
  harness: "Harness",
  status: "Status",
  visibility: "Visibility",
  cwd: "CWD",
};

/** Every column but cwd, in display order. */
const PADDED_COLUMNS = [
  "id",
  "name",
  "harness",
  "status",
  "visibility",
] as const;

type PaddedColumn = (typeof PADDED_COLUMNS)[number];

/** Between two columns: wider than the single space inside a cell such as a petname followed by a quoted self name, so a column boundary always reads as one. */
const COLUMN_GAP = "  ";

/** The table over rows: its header line, and the line for any one of rows, each aligned against every row and the header. */
export function agentTable(rows: readonly Readonly<AgentTableRow>[]): {
  header: string;
  line: (row: Readonly<AgentTableRow>) => string;
} {
  const widthOf = (column: PaddedColumn): number =>
    Math.max(...[HEADER, ...rows].map((row) => row[column].length));
  const widths: Readonly<Record<PaddedColumn, number>> = {
    id: widthOf("id"),
    name: widthOf("name"),
    harness: widthOf("harness"),
    status: widthOf("status"),
    visibility: widthOf("visibility"),
  };
  const line = (row: Readonly<AgentTableRow>): string =>
    [
      ...PADDED_COLUMNS.map((column) => row[column].padEnd(widths[column])),
      row.cwd,
    ].join(COLUMN_GAP);
  return { header: line(HEADER), line };
}
