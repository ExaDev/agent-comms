import { join } from "node:path";
import { selectCorpusFiles } from "./corpus-files.js";
import type { CorpusFile, Manifest } from "./corpus-types.js";
import { readText } from "./read-json.js";
import { validateCorpusText, validateManifestText } from "./validate.js";

/**
 * Loads and checks a whole corpus root by every rule `conformance/README.md` states: the files selected, each file valid, ids unique across files, and the corpus equal to its manifest. The real corpus and every fixture corpus under `conformance/fixtures/corpora` go through this one function, so a rule has one definition.
 */

export interface LoadedFile {
  readonly name: string;
  readonly file: CorpusFile;
}

export interface CheckedCorpus {
  readonly files: readonly LoadedFile[];
  /** Everything wrong with the corpus; empty when it is sound. */
  readonly problems: readonly string[];
}

/** What the files of a corpus say about themselves, in the manifest's own shape. */
function describeFiles(files: readonly LoadedFile[]): Record<string, string> {
  return Object.fromEntries(
    files.map(({ name, file }) => [
      name,
      JSON.stringify({
        cases: file.cases.length,
        skip: file.cases
          .filter((testCase) => testCase.skip !== undefined)
          .map((testCase) => testCase.id)
          .sort(),
      }),
    ]),
  );
}

/** The case ids this implementation registers to run and the ones it skips because they are marked for it alone. A case marked for the other implementation is registered and run here. */
export function collect(files: readonly LoadedFile[]): {
  readonly registered: readonly string[];
  readonly skipped: readonly string[];
} {
  const cases = files.flatMap(({ file }) => file.cases);

  return {
    registered: cases.filter(({ skip }) => skip !== "ts").map(({ id }) => id),
    skipped: cases.filter(({ skip }) => skip === "ts").map(({ id }) => id),
  };
}

/**
 * The completeness check, per implementation: what this implementation registered and skipped must add up to the manifest's total, and what it skips must be marked in the manifest. Cases marked for the other implementation count as registered here, so they cannot fail it.
 */
export function completenessProblems(
  total: number,
  markedIds: ReadonlySet<string>,
  registered: readonly string[],
  skipped: readonly string[],
): readonly string[] {
  const problems: string[] = [];
  if (registered.length + skipped.length !== total) {
    problems.push(
      `registered ${String(registered.length)} plus skipped ${String(skipped.length)} is not the manifest's ${String(total)}`,
    );
  }
  for (const id of skipped) {
    if (!markedIds.has(id)) {
      problems.push(`${id} is skipped here and not marked in the manifest`);
    }
  }
  if (
    new Set([...registered, ...skipped]).size !==
    registered.length + skipped.length
  ) {
    problems.push("a case is both registered and skipped, or registered twice");
  }

  return problems;
}

export function checkCorpus(root: string): CheckedCorpus {
  const selection = selectCorpusFiles(root);
  const problems = selection.problems.map(
    (path) => `${path}: not a corpus file and not a recognised root file`,
  );
  const files: LoadedFile[] = [];
  const ids = new Set<string>();
  for (const name of selection.selected) {
    const result = validateCorpusText(readText(join(root, name)));
    if (!result.ok) {
      problems.push(...result.problems.map((problem) => `${name}: ${problem}`));
      continue;
    }
    const directory = name.slice(0, name.indexOf("/"));
    for (const { id, kind } of result.value.cases) {
      if (kind !== directory) {
        problems.push(
          `${name}: case ${id} is of kind ${kind}, and the directory names kind ${directory}`,
        );
      }
      if (ids.has(id)) {
        problems.push(`${name}: case id ${id} is used by another file`);
      }
      ids.add(id);
    }
    files.push({ name, file: result.value });
  }
  let manifest: ReturnType<typeof validateManifestText>;
  try {
    manifest = validateManifestText(readText(join(root, "manifest.json")));
  } catch (error) {
    manifest = {
      ok: false,
      problems: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (!manifest.ok) {
    problems.push(
      ...manifest.problems.map((problem) => `manifest.json: ${problem}`),
    );
  } else {
    const recorded = Object.fromEntries(
      Object.entries(manifest.value.files).map(([name, entry]) => [
        name,
        JSON.stringify({ cases: entry.cases, skip: entry.skip }),
      ]),
    );
    const actual = describeFiles(files);
    const counts = collect(files);
    problems.push(
      ...completenessProblems(
        Object.values(manifest.value.files).reduce(
          (sum, entry) => sum + entry.cases,
          0,
        ),
        new Set(
          Object.values(manifest.value.files).flatMap((entry) => entry.skip),
        ),
        counts.registered,
        counts.skipped,
      ),
    );
    for (const name of new Set([
      ...Object.keys(recorded),
      ...Object.keys(actual),
    ])) {
      if (recorded[name] !== actual[name]) {
        problems.push(
          `manifest.json does not match ${name}: the file holds ${actual[name] ?? "nothing"}, the manifest records ${recorded[name] ?? "nothing"}`,
        );
      }
    }
  }

  return { files, problems };
}

/** One case as the runner registered it with the test framework, recorded in the loop that registers it. */
export interface Registration {
  readonly file: string;
  readonly id: string;
  readonly skip: "ts" | "rust" | undefined;
}

/**
 * What a run did, against what the manifest says the corpus holds: every file has as many registrations as the manifest has cases, the cases this implementation skips are the ones carrying `skip: ts` and are listed in the manifest, and every other registration ran. `registrations` is filled where the runner registers each case and `ran` where each registered case's body starts, so a runner that skips, filters or mis-keys cases reads as a failure here, and the corpus alone cannot make it pass.
 */
export function runCompletenessProblems(
  manifest: Manifest,
  registrations: readonly Registration[],
  ran: ReadonlySet<string>,
): readonly string[] {
  const problems: string[] = [];
  const perFile = new Map<string, number>();
  const seen = new Set<string>();
  for (const { file, id, skip } of registrations) {
    perFile.set(file, (perFile.get(file) ?? 0) + 1);
    if (seen.has(id)) {
      problems.push(`${id} was registered twice`);
    }
    seen.add(id);
    const entry = manifest.files[file];
    if (skip === "ts" && entry?.skip.includes(id) !== true) {
      problems.push(`${id} is skipped here and not listed in the manifest`);
    }
    if (skip !== "ts" && !ran.has(id)) {
      problems.push(`${id} was registered and did not run`);
    }
  }
  for (const [file, entry] of Object.entries(manifest.files)) {
    const count = perFile.get(file) ?? 0;
    if (count !== entry.cases) {
      problems.push(
        `${file}: ${String(count)} cases registered, the manifest has ${String(entry.cases)}`,
      );
    }
  }
  for (const file of perFile.keys()) {
    if (!(file in manifest.files)) {
      problems.push(`${file} was registered and is not in the manifest`);
    }
  }

  return problems;
}
