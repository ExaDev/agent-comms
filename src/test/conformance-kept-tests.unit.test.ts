import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FUNCTIONS } from "./conformance-functions.helper.js";
import { testTitles, valueImports } from "./conformance/test-titles.js";

/**
 * Holds the README's table of tests kept in TypeScript to the test files themselves, in both directions with exact titles: a test in a covered area that has no row fails, and a row that names a test which does not exist fails. A covered area is the modules the corpus has cases for (`COVERED_MODULES`). A test file is in scope when it is named in the table, when it is named after a covered module, or when the package modules it imports by value are covered modules alone, apart from `LEAF_MODULES` (data definitions and version readers) and test support, so a unit test of a covered module is held to the table whatever the file is called. A test that also imports other modules is a test of those and is in scope only when the table names its file.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE = join(ROOT, "src");
const SECTION = "## Tests kept in TypeScript";
/** The columns of the table: file, test and reason. */
const COLUMNS = 3;

/** The source file of every module the call table has functions for, by the module name its entries start with. */
const COVERED_MODULES: Readonly<Record<string, string>> = {
  "agent-table": "src/core/agent-table.ts",
  "bind-retry": "src/core/bind-retry.ts",
  "boot-logic": "src/bridges/user/web/frontend/boot-logic.ts",
  bridge: "src/core/bridge.ts",
  "claude-command": "src/bridges/claude-code/claudeCommand.ts",
  "default-command": "src/core/default-command.ts",
  "delegation-policy": "src/core/delegation-policy.ts",
  "display-name": "src/core/display-name.ts",
  "error-reporting": "src/core/error-reporting.ts",
  "gossip-extensions": "src/core/gossip-extensions.ts",
  input: "src/bridges/user/web/frontend/input.ts",
  "machine-list-groups": "src/core/machine-list-groups.ts",
  messages: "src/bridges/user/web/frontend/messages.ts",
  "project-tree": "src/bridges/user/web/frontend/project-tree.ts",
  "relay-selection": "src/core/relay-selection.ts",
  "request-timeouts": "src/core/request-timeouts.ts",
  "room-discovery": "src/core/room-discovery.ts",
  "room-lookup": "src/core/room-lookup.ts",
  "room-path": "src/core/room-path.ts",
  "room-wire-extensions": "src/core/room-wire-extensions.ts",
  "send-outcome": "src/core/send-outcome.ts",
  "served-by-bridge": "src/bridges/user/web/frontend/served-by-bridge.ts",
  "url-sync": "src/bridges/user/web/frontend/url-sync.ts",
  "version-report-actions": "src/core/version-report-actions.ts",
  "web-access": "src/bridges/user/web/web-access.ts",
};

/** Test files that cover a corpus module under a shorter name than the call table gives it. */
const STEM_ALIASES: Readonly<Record<string, string>> = {
  "boot-logic": "boot",
};

/** Package modules a unit test of a covered module may import as well: data definitions, the error class and the readers of the running package's own versions. */
const LEAF_MODULES: ReadonlySet<string> = new Set([
  "src/core/types.ts",
  "src/core/store.ts",
  "src/core/package-version.ts",
  "src/core/wire-mesh-core-version.ts",
]);

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

/** Whether a package module is test support, which is never a module under test. */
function isTestSupport(file: string): boolean {
  return /(^|\/)test\//u.test(file) || /(^|\/)[a-z-]+\.helper\.ts$/u.test(file);
}

/** Whether a test file is in scope by what it imports: at least one covered module, and no package module that is neither covered, a leaf nor test support. */
function importsCoveredModulesAlone(
  path: string,
  covered: ReadonlySet<string>,
): boolean {
  const imports = valueImports(path, ROOT, (candidate) =>
    existsSync(candidate),
  ).filter((file) => !isTestSupport(file));

  return (
    imports.some((file) => covered.has(file)) &&
    imports.every((file) => covered.has(file) || LEAF_MODULES.has(file))
  );
}

/** Every `file | title` pair the tests in scope define, as the table writes them. */
function keptTests(
  rows: readonly Row[],
  files: readonly string[] = testFiles(SOURCE),
): ReadonlySet<string> {
  const stems = new Set(
    Object.keys(COVERED_MODULES).map(
      (module) => STEM_ALIASES[module] ?? module,
    ),
  );
  const covered = new Set(Object.values(COVERED_MODULES));
  const named = new Set(rows.map((row) => row.file));
  const found = new Set<string>();
  for (const path of files) {
    const file = relative(ROOT, path);
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const stem = basename.slice(0, basename.indexOf("."));
    if (
      !stems.has(stem) &&
      !named.has(file) &&
      !importsCoveredModulesAlone(path, covered)
    ) {
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

  it("covers every module the call table has functions for, in files that exist", () => {
    const prefixes = new Set(
      Object.keys(FUNCTIONS).map((name) => name.split(".")[0] ?? ""),
    );
    expect([...prefixes].sort()).toEqual(Object.keys(COVERED_MODULES).sort());
    for (const file of Object.values(COVERED_MODULES)) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
    }
  });

  it("puts a test file in scope by what it imports, whatever it is called", () => {
    const covered = new Set(Object.values(COVERED_MODULES));
    expect(
      importsCoveredModulesAlone(
        join(SOURCE, "core", "test", "build-action.unit.test.ts"),
        covered,
      ),
    ).toBe(true);
    expect(
      importsCoveredModulesAlone(
        join(SOURCE, "test", "mcp-tool-action-enum.unit.test.ts"),
        covered,
      ),
    ).toBe(true);
    // A test of the room lifecycle imports a covered module to build ids, and is a test of the lifecycle.
    expect(
      importsCoveredModulesAlone(
        join(SOURCE, "test", "room-lifecycle.unit.test.ts"),
        covered,
      ),
    ).toBe(false);
  });

  it("refuses a test whose title is not a string literal, naming the file and line", () => {
    const directory = mkdtempSync(join(tmpdir(), "kept-tests-"));
    try {
      const file = join(directory, "generated.unit.test.ts");
      writeFileSync(
        file,
        'import { describe, it } from "vitest";\nfor (const n of ["a"]) {\n  describe(`g ${n}`, () => {\n    it("t", () => undefined);\n  });\n}\n',
      );
      expect(() => testTitles(file)).toThrow(
        `${file}:3: the title of this describe is not a string literal`,
      );
    } finally {
      rmSync(directory, { recursive: true });
    }
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
