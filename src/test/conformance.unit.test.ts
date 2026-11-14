import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkCorpus,
  runCompletenessProblems,
  type Registration,
} from "./conformance/corpus.js";
import { selectCorpusFiles } from "./conformance/corpus-files.js";
import type {
  FunctionCase,
  Manifest,
  Text,
  ValidateCase,
} from "./conformance/corpus-types.js";
import { KINDS, SKIP_VALUES } from "./conformance/corpus-types.js";
import { readJson } from "./conformance/read-json.js";
import {
  decodeValue,
  textToCodeUnits,
  specialNumberName,
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

/** What a function returned, as the value a case expects: an `undefined` stays one, anything else is what `JSON.stringify` makes of it, except that a number the JSON form cannot hold (a negative zero, an infinity, NaN) is kept as the number. */
function toJson(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  const text = JSON.stringify(value, (_key, item: unknown) => {
    const name = typeof item === "number" ? specialNumberName(item) : undefined;

    return name === undefined ? item : { $number: name };
  });
  if (text === undefined) {
    throw new Error("the function returned a value JSON cannot hold");
  }

  return decodeValue(JSON.parse(text));
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
    if (issue.code !== undefined) {
      expect(result.issues[position]?.code).toBe(issue.code);
    }
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

  it("reads the four special numbers as the numbers they name, and nothing else", () => {
    const decoded = decodeValue([
      { $number: "-0" },
      { $number: "Infinity" },
      { $number: "-Infinity" },
      { $number: "NaN" },
      { a: { $number: "-0" } },
    ]);
    expect(decoded).toEqual([
      -0,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      { a: -0 },
    ]);
    expect(Object.is((decoded as unknown[])[0], -0)).toBe(true);
    expect(() => decodeValue({ $number: "1" })).toThrow("$number");
    expect(specialNumberName(-0)).toBe("-0");
    expect(specialNumberName(0)).toBeUndefined();
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

  it("types the case kinds and the skip values the schema defines, and no others", () => {
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
    expect(dig(schema, "$defs", "skip", "enum")).toEqual([...SKIP_VALUES]);
  });
});

const checked = checkCorpus(CORPUS_ROOT);
if (checked.problems.length > 0) {
  throw new Error(`the corpus is malformed:\n${checked.problems.join("\n")}`);
}
const corpus = checked.files;

// Each case is recorded where it is registered, and again where its body starts, so the completeness check at the end reads what this run did and not what the corpus says: a loop that skips, filters or mis-keys cases, or a framework option that skips them, shows as a failure there. A run that selects tests by name or stops early fails it too, so the whole file is run.
const registrations: Registration[] = [];
const ran = new Set<string>();

for (const { name, file } of corpus) {
  describe(`conformance ${name}`, () => {
    for (const testCase of file.cases) {
      registrations.push({ file: name, id: testCase.id, skip: testCase.skip });
      const register = testCase.skip === "ts" ? it.skip : it;
      register(`${testCase.id} (${testCase.from})`, async () => {
        ran.add(testCase.id);
        if (testCase.kind === "function") {
          await runFunctionCase(testCase);
        } else {
          runValidateCase(testCase);
        }
      });
    }
  });
}

describe("corpus completeness", () => {
  const manifest = validateManifest(
    readJson(join(CORPUS_ROOT, "manifest.json")),
  );

  it("ran every case the manifest holds that this implementation does not skip", () => {
    if (!manifest.ok) {
      throw new Error(manifest.problems.join("\n"));
    }
    expect(runCompletenessProblems(manifest.value, registrations, ran)).toEqual(
      [],
    );
  });

  describe("fails for a run that did not do what the manifest says", () => {
    const held: Manifest = {
      files: {
        "function/a.json": { cases: 2, skip: ["b"] },
        "function/c.json": { cases: 1, skip: [] },
      },
    };
    const full: Registration[] = [
      { file: "function/a.json", id: "a", skip: undefined },
      { file: "function/a.json", id: "b", skip: "ts" },
      { file: "function/c.json", id: "c", skip: undefined },
    ];

    it("passes when every case is registered and each one not skipped ran", () => {
      expect(runCompletenessProblems(held, full, new Set(["a", "c"]))).toEqual(
        [],
      );
    });

    it("fails when the framework skipped every case", () => {
      expect(runCompletenessProblems(held, full, new Set())).toEqual([
        "a was registered and did not run",
        "c was registered and did not run",
      ]);
    });

    it("fails when a case was never registered", () => {
      expect(
        runCompletenessProblems(held, full.slice(1), new Set(["c"])),
      ).toContain("function/a.json: 1 cases registered, the manifest has 2");
    });

    it("fails when a case is registered under another file", () => {
      const moved = full.map((entry) =>
        entry.id === "c" ? { ...entry, file: "function/a.json" } : entry,
      );
      expect(runCompletenessProblems(held, moved, new Set(["a", "c"]))).toEqual(
        [
          "function/a.json: 3 cases registered, the manifest has 2",
          "function/c.json: 0 cases registered, the manifest has 1",
        ],
      );
    });

    it("fails when a case is skipped here and the manifest does not list it", () => {
      const unlisted = full.map((entry) =>
        entry.id === "a" ? { ...entry, skip: "ts" as const } : entry,
      );
      expect(runCompletenessProblems(held, unlisted, new Set(["c"]))).toEqual([
        "a is skipped here and not listed in the manifest",
      ]);
    });

    it("does not need a case that skips the other implementation to be skipped here", () => {
      const other = full.map((entry) =>
        entry.id === "a" ? { ...entry, skip: "rust" as const } : entry,
      );
      expect(runCompletenessProblems(held, other, new Set(["a", "c"]))).toEqual(
        [],
      );
    });
  });
});
