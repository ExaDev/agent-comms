import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkCorpus,
  collect,
  completenessProblems,
} from "./conformance/corpus.js";
import { selectCorpusFiles } from "./conformance/corpus-files.js";
import type {
  FunctionCase,
  Text,
  ValidateCase,
} from "./conformance/corpus-types.js";
import { KINDS, ONLY_VALUES } from "./conformance/corpus-types.js";
import { readJson } from "./conformance/read-json.js";
import {
  decodeValue,
  textToCodeUnits,
  textToString,
} from "./conformance/text.js";
import {
  validateCorpusFile,
  validateManifest,
} from "./conformance/validate.js";
import {
  errorCode,
  FUNCTIONS,
  SCHEMAS,
} from "./conformance-functions.helper.js";

/**
 * Runs the TypeScript implementation's share of the language-neutral conformance corpus (`conformance/` at the repository root). The format, the file selection rule and the matching rules are in `conformance/README.md`; `conformance/case.schema.json` is the schema every file is validated against before anything runs.
 *
 * Nothing about the corpus is trusted: a file that does not match the format, an unexpected entry in the tree, a corpus that differs from `conformance/manifest.json` and a case this runner cannot execute all fail the run rather than being skipped, since a skipped case reads as a case that passes.
 */

const CORPUS_ROOT = fileURLToPath(
  new URL("../../conformance/", import.meta.url),
);
const FIXTURES = join(CORPUS_ROOT, "fixtures");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextPair(
  value: unknown,
): value is { text: string; codeUnits: readonly number[] } {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    Array.isArray(value.codeUnits) &&
    value.codeUnits.every((unit: unknown) => typeof unit === "number")
  );
}

function stringList(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where}: expected a list`);
  }

  return value.map((item: unknown) => {
    if (typeof item !== "string") {
      throw new Error(`${where}: expected a list of strings`);
    }

    return item;
  });
}

/** Whether every fragment occurs in `text`, each after the end of the one before. */
function containsInOrder(text: string, fragments: readonly Text[]): boolean {
  let from = 0;
  for (const fragment of fragments) {
    const wanted = textToString(fragment);
    const at = text.indexOf(wanted, from);
    if (at === -1) {
      return false;
    }
    from = at + wanted.length;
  }

  return true;
}

/** An object matches when every key `expected` gives matches; an array matches element by element at the same length; any other value must be equal. */
function subsetMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item: unknown, position) =>
        subsetMatches(actual[position], item),
      )
    );
  }
  if (isRecord(expected)) {
    return (
      isRecord(actual) &&
      Object.entries(expected).every(([key, value]) =>
        subsetMatches(actual[key], value),
      )
    );
  }

  return Object.is(actual, expected);
}

/** What a function returned, as the JSON value a case expects: an `undefined` stays one, and anything else is what `JSON.stringify` makes of it. */
function toJson(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error("the function returned a value JSON cannot hold");
  }

  return JSON.parse(text);
}

async function runFunctionCase(testCase: FunctionCase): Promise<void> {
  const implementation = FUNCTIONS[testCase.function];
  if (implementation === undefined) {
    throw new Error(`no function named ${testCase.function} in the call table`);
  }
  const args = testCase.args.map((arg) => decodeValue(arg));
  if (testCase.throws !== undefined) {
    let thrown: unknown;
    try {
      await implementation(...args);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "the call must throw").toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    const { code, message: fragments } = testCase.throws;
    if (code !== undefined) {
      expect(errorCode(thrown)).toBe(code);
    }
    if (fragments !== undefined) {
      expect(
        containsInOrder(message, fragments),
        `message ${JSON.stringify(message)} lacks, in order, ${JSON.stringify(fragments)}`,
      ).toBe(true);
    }

    return;
  }
  const actual = toJson(await implementation(...args));
  if (testCase.expectUndefined === true) {
    expect(actual).toBeUndefined();
  } else if (testCase.expectSubset !== undefined) {
    expect(
      subsetMatches(actual, decodeValue(testCase.expectSubset)),
      `${JSON.stringify(actual)} does not hold ${JSON.stringify(testCase.expectSubset)}`,
    ).toBe(true);
  } else {
    expect(actual).toEqual(decodeValue(testCase.expect));
  }
}

function runValidateCase(testCase: ValidateCase): void {
  const validate = SCHEMAS[testCase.schema];
  if (validate === undefined) {
    throw new Error(`no schema named ${testCase.schema} in the call table`);
  }
  const result = validate(decodeValue(testCase.input));
  const { expect: expectation } = testCase;
  if (expectation.ok) {
    expect(result.ok, `rejected: ${JSON.stringify(result)}`).toBe(true);
    if (expectation.value !== undefined && result.ok) {
      expect(toJson(result.value)).toEqual(decodeValue(expectation.value));
    }

    return;
  }
  expect(result.ok, "must be rejected").toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.issues.map((issue) => issue.path)).toEqual(
    expectation.issues.map((issue) => issue.path),
  );
  expectation.issues.forEach((issue, position) => {
    const fragments = issue.message;
    const actualMessage = result.issues[position]?.message ?? "";
    if (fragments !== undefined) {
      expect(
        containsInOrder(actualMessage, fragments),
        `message ${JSON.stringify(actualMessage)} lacks, in order, ${JSON.stringify(fragments)}`,
      ).toBe(true);
    }
  });
}

/** The names of the entries in a fixture directory, which must hold at least one. */
function fixtureNames(directory: string): readonly string[] {
  const names = readdirSync(join(FIXTURES, directory)).sort();
  expect(names.length, `${directory} holds no fixtures`).toBeGreaterThan(0);

  return names;
}

/** Whether a loader rejects the file: a file that cannot be parsed is rejected too. */
function rejects(
  path: string,
  validate: (value: unknown) => { readonly ok: boolean },
): boolean {
  try {
    return !validate(readJson(path)).ok;
  } catch {
    return true;
  }
}

/**
 * A negative fixture must fail for the rule it exists for. Each file in `invalid` has a file of the same name in `repaired` that differs by that one defect and is valid, so the invalid one cannot stay rejected for another reason.
 */
function expectPairs(
  invalid: string,
  repaired: string,
  validate: (value: unknown) => {
    readonly ok: boolean;
    readonly problems?: readonly string[];
  },
): void {
  const names = fixtureNames(invalid);
  expect(fixtureNames(repaired), "every fixture has a repaired twin").toEqual(
    names,
  );
  const accepted = names.filter(
    (name) => !rejects(join(FIXTURES, invalid, name), validate),
  );
  expect(accepted, `${invalid} fixtures that validate`).toEqual([]);
  for (const name of names) {
    const result = validate(readJson(join(FIXTURES, repaired, name)));
    expect(result.ok ? [] : result.problems, `${repaired}/${name}`).toEqual([]);
  }
}

/** The value at a path of keys, or undefined. */
function dig(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }

  return current;
}

describe("corpus loading", () => {
  it("selects the files the README's rule selects, over the shared fixture tree", () => {
    const expected = readJson(
      join(FIXTURES, "loader-selection", "expected.json"),
    );
    if (!isRecord(expected)) {
      throw new Error("expected.json must be an object");
    }
    const selection = selectCorpusFiles(
      join(FIXTURES, "loader-selection", "tree"),
    );
    expect({
      problems: selection.problems,
      selected: selection.selected,
    }).toEqual({
      problems: stringList(expected.problems, "problems"),
      selected: stringList(expected.selected, "selected"),
    });
  });

  it("finds nothing wrong with the real corpus", () => {
    expect(checkCorpus(CORPUS_ROOT).problems).toEqual([]);
  });

  it("rejects every invalid-case fixture, each for its one defect", () => {
    expectPairs("invalid-cases", "repaired-cases", validateCorpusFile);
  });

  it("rejects every invalid manifest fixture, each for its one defect", () => {
    expectPairs("manifests/invalid", "manifests/repaired", validateManifest);
  });

  it("rejects every invalid corpus fixture, each for its one defect", () => {
    const names = fixtureNames("corpora/invalid");
    expect(fixtureNames("corpora/repaired")).toEqual(names);
    for (const name of names) {
      expect(
        checkCorpus(join(FIXTURES, "corpora", "invalid", name)).problems.length,
        `corpora/invalid/${name} must have a problem`,
      ).toBeGreaterThan(0);
      expect(
        checkCorpus(join(FIXTURES, "corpora", "repaired", name)).problems,
        `corpora/repaired/${name}`,
      ).toEqual([]);
    }
  });

  it("accepts every valid fixture", () => {
    for (const name of fixtureNames("valid-cases")) {
      const result = validateCorpusFile(
        readJson(join(FIXTURES, "valid-cases", name)),
      );
      expect(result.ok ? [] : result.problems, name).toEqual([]);
    }
    for (const name of fixtureNames("manifests/valid")) {
      const result = validateManifest(
        readJson(join(FIXTURES, "manifests", "valid", name)),
      );
      expect(result.ok ? [] : result.problems, name).toEqual([]);
    }
  });

  it("reads both forms of a text as the same UTF-16 code units", () => {
    const document = readJson(join(FIXTURES, "text-forms", "pairs.json"));
    const list: unknown = isRecord(document) ? document.pairs : undefined;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("pairs.json must hold a non-empty list of pairs");
    }
    for (const pair of list) {
      if (!isTextPair(pair)) {
        throw new Error("a pair holds a text and its code units");
      }
      expect(textToCodeUnits(pair.text)).toEqual(pair.codeUnits);
      expect(textToCodeUnits({ codeUnits: pair.codeUnits })).toEqual(
        pair.codeUnits,
      );
      expect(textToString({ codeUnits: pair.codeUnits })).toBe(pair.text);
    }
  });

  it("types the case kinds and the only values the schema defines, and no others", () => {
    const schema = readJson(join(CORPUS_ROOT, "case.schema.json"));
    const refs = dig(schema, "$defs", "case", "oneOf");
    if (!Array.isArray(refs)) {
      throw new Error("the schema's $defs.case.oneOf must be a list");
    }
    const kinds = refs.map((reference: unknown) => {
      const target = dig(reference, "$ref");
      const name = typeof target === "string" ? target.split("/").pop() : "";
      const kind = dig(
        schema,
        "$defs",
        name ?? "",
        "properties",
        "kind",
        "const",
      );
      if (typeof kind !== "string") {
        throw new Error(`no kind constant behind ${JSON.stringify(target)}`);
      }

      return kind;
    });
    expect([...kinds].sort()).toEqual([...KINDS].sort());
    expect(dig(schema, "$defs", "only", "enum")).toEqual([...ONLY_VALUES]);
  });
});

const checked = checkCorpus(CORPUS_ROOT);
if (checked.problems.length > 0) {
  throw new Error(`the corpus is malformed:\n${checked.problems.join("\n")}`);
}
const corpus = checked.files;

// What this run registers, computed while the tests are collected, so the completeness check below holds whatever the run does with them afterwards: a name filter, a bail, a retry or a shuffled order changes which registered tests run, never which are registered.
const { registered, skipped } = collect(corpus);
const registeredIds = new Set(registered);

for (const { name, file } of corpus) {
  describe(`conformance ${name}`, () => {
    for (const testCase of file.cases) {
      it.skipIf(!registeredIds.has(testCase.id))(
        `${testCase.id} (${testCase.from})`,
        async () => {
          if (testCase.kind === "function") {
            await runFunctionCase(testCase);
          } else {
            runValidateCase(testCase);
          }
        },
      );
    }
  });
}

describe("corpus completeness", () => {
  const manifest = validateManifest(
    readJson(join(CORPUS_ROOT, "manifest.json")),
  );

  it("registers and skips cases so that they add up to the manifest, per implementation", () => {
    if (!manifest.ok) {
      throw new Error(manifest.problems.join("\n"));
    }
    const entries = Object.values(manifest.value.files);
    expect(
      completenessProblems(
        entries.reduce((sum, entry) => sum + entry.cases, 0),
        new Set(entries.flatMap((entry) => entry.only)),
        registered,
        skipped,
      ),
    ).toEqual([]);
  });
});
