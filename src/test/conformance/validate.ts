import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import type { CorpusFile, Manifest } from "./corpus-types.js";

/**
 * Validates corpus files and the manifest against the schemas in `conformance/`, which is the whole definition of the format. The checks beside the schema are the rules JSON Schema cannot express and `conformance/README.md` lists: a case id is not repeated within a file, a manifest's `skip` lists are in ascending order, and no JSON string holds an unpaired surrogate (content that needs one is written as `{ "codeUnits": [...] }`). Nothing else is validated by hand.
 */

export type Validation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly string[] };

function readSchema(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../conformance/${name}`, import.meta.url)),
      "utf8",
    ),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must hold a JSON object`);
  }

  return Object.fromEntries(Object.entries(parsed));
}

// Strict mode, so a schema keyword Ajv does not know is an error rather than ignored; unions of types are what the schema's open "any JSON value" definitions use.
// ajv ships CommonJS with a default export, which Node16 resolution types as the module and not the class.
const Ajv2020 = Ajv2020Module.default;
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
});

// The generic states what a document the schema accepted holds; it is the schema, not this code, that makes it true.
const checkCorpusFile = ajv.compile<CorpusFile>(readSchema("case.schema.json"));
const checkManifest = ajv.compile<Manifest>(readSchema("manifest.schema.json"));

function describeErrors(
  errors:
    readonly { instancePath: string; message?: string }[] | null | undefined,
): readonly string[] {
  if (errors === null || errors === undefined) {
    return ["the schema rejected the document"];
  }

  return errors.map(
    ({ instancePath, message }) =>
      `${instancePath === "" ? "(root)" : instancePath} ${message ?? "is invalid"}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where a JSON string, or an object key, holds an unpaired surrogate: such a document is read differently by different loaders. */
function malformedStrings(value: unknown, where: string): readonly string[] {
  if (typeof value === "string") {
    return value.isWellFormed() ? [] : [`${where} holds an unpaired surrogate`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown, index) =>
      malformedStrings(item, `${where}/${String(index)}`),
    );
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, item]) => [
      ...malformedStrings(key, `${where}/(key)`),
      ...malformedStrings(item, `${where}/${key}`),
    ]);
  }

  return [];
}

function ruleProblems(file: CorpusFile): readonly string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const testCase of file.cases) {
    if (ids.has(testCase.id)) {
      problems.push(`case id ${testCase.id} is used twice in the file`);
    }
    ids.add(testCase.id);
  }

  return problems;
}

export function validateCorpusFile(value: unknown): Validation<CorpusFile> {
  const malformed = malformedStrings(value, "");
  if (malformed.length > 0) {
    return { ok: false, problems: malformed };
  }
  if (!checkCorpusFile(value)) {
    return { ok: false, problems: describeErrors(checkCorpusFile.errors) };
  }
  const problems = ruleProblems(value);

  return problems.length === 0 ? { ok: true, value } : { ok: false, problems };
}

/** Whether the ids are distinct and in ascending UTF-16 code unit order, which is the order every loader sorts in for the ASCII ids the schema allows. */
function isAscending(ids: readonly string[]): boolean {
  return ids.every((id, index) => {
    const before = ids[index - 1];

    return before === undefined || before < id;
  });
}

export function validateManifest(value: unknown): Validation<Manifest> {
  if (!checkManifest(value)) {
    return { ok: false, problems: describeErrors(checkManifest.errors) };
  }
  const problems = Object.entries(value.files).flatMap(([name, entry]) =>
    isAscending(entry.skip)
      ? []
      : [`${name}: "skip" must list distinct ids in ascending order`],
  );

  return problems.length === 0 ? { ok: true, value } : { ok: false, problems };
}

type Frame =
  | { readonly kind: "array" }
  | { kind: "object"; expectKey: boolean; last: string | undefined };

/** The index just past the string literal that starts at `start`, which is a double quote. */
function endOfString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length && text[index] !== '"') {
    index += text[index] === "\\" ? 2 : 1;
  }

  return index + 1;
}

/**
 * The problems with the order of the keys in a corpus file's own text, which no parsed value can show: `JSON.parse` puts integer-like keys first in numeric order, whatever order the file wrote them in. Within every object the keys are in UTF-16 code unit order, which is how JavaScript compares strings, each key after the one before and none repeated, so integer-like keys are ordered as the strings they are; a key holding an unpaired surrogate is refused, since no loader reads it the same way.
 */
export function keyOrderProblems(text: string): readonly string[] {
  const problems: string[] = [];
  const stack: Frame[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const top = stack[stack.length - 1];
    if (char === '"') {
      const end = endOfString(text, index);
      if (top?.kind === "object" && top.expectKey) {
        const key = String(JSON.parse(text.slice(index, end)));
        if (!key.isWellFormed()) {
          problems.push(
            `a key holds an unpaired surrogate: ${JSON.stringify(text.slice(index, end))}`,
          );
        } else if (top.last !== undefined && key <= top.last) {
          problems.push(
            `key ${JSON.stringify(key)} comes after ${JSON.stringify(top.last)}, and keys are in UTF-16 code unit order without repeats`,
          );
        }
        top.last = key;
        top.expectKey = false;
      }
      index = end;
      continue;
    }
    if (char === "{") {
      stack.push({ kind: "object", expectKey: true, last: undefined });
    } else if (char === "[") {
      stack.push({ kind: "array" });
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === "," && top?.kind === "object") {
      top.expectKey = true;
    }
    index += 1;
  }

  return problems;
}

/** A corpus file's text: its key order, then the file itself as validateCorpusFile reads it. A text that is not JSON throws, as it does for every loader. */
export function validateCorpusText(text: string): Validation<CorpusFile> {
  const order = keyOrderProblems(text);

  return order.length > 0
    ? { ok: false, problems: order }
    : validateCorpusFile(JSON.parse(text));
}

/** The manifest's text, checked as validateCorpusText checks a corpus file's. */
export function validateManifestText(text: string): Validation<Manifest> {
  const order = keyOrderProblems(text);

  return order.length > 0
    ? { ok: false, problems: order }
    : validateManifest(JSON.parse(text));
}
