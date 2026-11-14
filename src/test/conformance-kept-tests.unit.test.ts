import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FUNCTIONS } from "./conformance-functions.helper.js";
import { testTitles } from "./conformance/test-titles.js";

/**
 * Holds the README's table of tests kept in TypeScript to the test files themselves, in both directions with exact titles: a test in a covered area that has no row fails, and a row that names a test which does not exist fails. A covered area is a module the corpus has cases for, so a test file named after one of them is in scope, and so is every file the table names.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE = join(ROOT, "src");
const SECTION = "## Tests kept in TypeScript";
/** The columns of the table: file, test and reason. */
const COLUMNS = 3;

/** Test files that cover a corpus module under a shorter name than the call table gives it. */
const STEM_ALIASES: Readonly<Record<string, string>> = {
  "boot-logic": "boot",
};

interface Row {
  readonly file: string;
  readonly title: string;
  readonly reason: string;
}

function readme(): string {
  return readFileSync(join(ROOT, "conformance", "README.md"), "utf8");
}

/** The table's rows and the reason codes the section defines, read from the README. */
function keptTable(): { rows: readonly Row[]; reasons: readonly string[] } {
  const text = readme();
  const start = text.indexOf(SECTION);
  if (start === -1) {
    throw new Error(`the README has no "${SECTION}" section`);
  }
  const rest = text.slice(start + SECTION.length);
  const next = rest.search(/^## /mu);
  const lines = (next === -1 ? rest : rest.slice(0, next)).split("\n");
  const rows: Row[] = [];
  for (const line of lines.filter((candidate) => candidate.startsWith("|"))) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [file, title, reason] = cells;
    if (
      cells.length !== COLUMNS ||
      file === undefined ||
      title === undefined ||
      reason === undefined
    ) {
      throw new Error(
        `a row of the kept tests table has ${String(cells.length)} cells: ${line}`,
      );
    }
    if (file === "File" || /^-+$/u.test(file)) {
      continue;
    }
    rows.push({
      file: file.replace(/^`|`$/gu, ""),
      title: title.replace(/^`|`$/gu, ""),
      reason: reason.replace(/^`|`$/gu, ""),
    });
  }
  const reasons = [...lines.join("\n").matchAll(/^- `([a-z-]+)`:/gmu)].map(
    (match) => match[1] ?? "",
  );

  return { rows, reasons };
}

function testFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "dist"
        ? []
        : testFiles(path);
    }

    return /\.test\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

/** Every `file | title` pair the tests in scope define, as the table writes them. */
function keptTests(
  rows: readonly Row[],
  files: readonly string[] = testFiles(SOURCE),
): ReadonlySet<string> {
  const stems = new Set(
    Object.keys(FUNCTIONS).map((name) => {
      const module = name.split(".")[0] ?? "";

      return STEM_ALIASES[module] ?? module;
    }),
  );
  const named = new Set(rows.map((row) => row.file));
  const found = new Set<string>();
  for (const path of files) {
    const file = relative(ROOT, path);
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const stem = basename.slice(0, basename.indexOf("."));
    if (!stems.has(stem) && !named.has(file)) {
      continue;
    }
    for (const title of testTitles(path)) {
      found.add(`${file} | ${title}`);
    }
  }

  return found;
}

/** What a comparison of the table with the tests found says is wrong with it. */
function tableProblems(
  rows: readonly Row[],
  found: ReadonlySet<string>,
): readonly string[] {
  const listed = rows.map((row) => `${row.file} | ${row.title}`);
  const problems: string[] = [];
  for (const entry of found) {
    if (!listed.includes(entry)) {
      problems.push(`no row for the test ${entry}`);
    }
  }
  for (const entry of listed) {
    if (!found.has(entry)) {
      problems.push(`the row ${entry} names no test`);
    }
  }
  if (new Set(listed).size !== listed.length) {
    problems.push("a row is listed twice");
  }

  return problems;
}

describe("the table of tests kept in TypeScript", () => {
  const { rows, reasons } = keptTable();

  it("lists every test of a covered area exactly, and no test that is not there", () => {
    expect(tableProblems(rows, keptTests(rows))).toEqual([]);
  });

  it("gives every row a reason code the section defines", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(reasons, `${row.file} | ${row.title}`).toContain(row.reason);
    }
  });

  describe("fails when the table and the tests differ", () => {
    const only: Row = {
      file: "src/test/a.unit.test.ts",
      title: "t",
      reason: "file",
    };

    it("passes when they agree", () => {
      expect(
        tableProblems([only], new Set(["src/test/a.unit.test.ts | t"])),
      ).toEqual([]);
    });

    it("fails for a test with no row, including one whose title only starts like a row's", () => {
      expect(
        tableProblems(
          [only],
          new Set([
            "src/test/a.unit.test.ts | t",
            "src/test/a.unit.test.ts | reads",
          ]),
        ),
      ).toEqual(["no row for the test src/test/a.unit.test.ts | reads"]);
      expect(
        tableProblems([only], new Set(["src/test/a.unit.test.ts | t two"])),
      ).toHaveLength(2);
    });

    it("fails for a row whose test was deleted", () => {
      expect(tableProblems([only], new Set())).toEqual([
        "the row src/test/a.unit.test.ts | t names no test",
      ]);
    });
  });

  it("reads a test's title with the names of the blocks around it, as a table row writes it", () => {
    const titles = testTitles(
      join(ROOT, "src", "test", "claude-command.unit.test.ts"),
    );
    expect(titles).toEqual([
      "hooks/drain.sh > matches the process forms the bridge matches",
    ]);
  });
});
