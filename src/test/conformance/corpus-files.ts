import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

/**
 * Which files under the corpus root are corpus files, by the one rule `conformance/README.md` states. Every loader of the corpus (this one, the native crates' and the wasm runner's) implements the same rule, and each runs it over the fixture tree in `conformance/fixtures/loader-selection` so the three cannot disagree.
 */

/** Directories that hold data cases refer to or the runners themselves, never cases, wherever they appear. */
const NON_CASE_DIRECTORIES: ReadonlySet<string> = new Set([
  "fixtures",
  "schema",
  "runner",
]);

/** The files the corpus root itself holds. */
const ROOT_FILES: ReadonlySet<string> = new Set([
  "README.md",
  "case.schema.json",
  "manifest.json",
  "manifest.schema.json",
]);

export interface CorpusSelection {
  /** Corpus files as `/`-separated paths relative to the root, in the order a walk in UTF-16 code unit order finds them. */
  readonly selected: readonly string[];
  /** Entries that are neither a corpus file, a known root file nor a skipped directory, in the same order. */
  readonly problems: readonly string[];
}

/** The characters a directory or file name outside the root's own files may use, so every loader orders names the same way. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** The depth at which a directory holds corpus files: `<kind>/<name>.json`. */
const AREA_DEPTH = 1;

function byName(left: Dirent, right: Dirent): number {
  if (left.name === right.name) {
    return 0;
  }

  return left.name < right.name ? -1 : 1;
}

function scan(
  root: string,
  relative: string,
  depth: number,
  selection: { selected: string[]; problems: string[] },
): void {
  const entries = readdirSync(join(root, relative), { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort(byName);
  for (const entry of entries) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (NON_CASE_DIRECTORIES.has(entry.name)) {
        continue;
      }
      if (depth < AREA_DEPTH && NAME_PATTERN.test(entry.name)) {
        scan(root, path, depth + 1, selection);
      } else {
        selection.problems.push(path);
      }
    } else if (entry.isFile() && depth === 0 && ROOT_FILES.has(entry.name)) {
      continue;
    } else if (
      entry.isFile() &&
      depth === AREA_DEPTH &&
      entry.name.endsWith(".json") &&
      NAME_PATTERN.test(entry.name)
    ) {
      selection.selected.push(path);
    } else {
      selection.problems.push(path);
    }
  }
}

/**
 * Applies the selection rule to the tree at `root`. A name starting with a dot is ignored at any depth, a directory named `fixtures`, `schema` or `runner` is skipped at any depth, and everything else must be a `.json` file at `<kind>/<name>.json`, with names of lower-case ASCII letters, digits, dots, hyphens and underscores, or one of the root's own files; anything else is returned in `problems`, for the caller to fail on.
 */
export function selectCorpusFiles(root: string): CorpusSelection {
  const selection: { selected: string[]; problems: string[] } = {
    selected: [],
    problems: [],
  };
  scan(root, "", 0, selection);

  return selection;
}
