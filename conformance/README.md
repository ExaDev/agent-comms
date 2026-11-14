# Conformance corpus

Language-neutral cases that pin the behaviour of agent-comms. Every implementation (the TypeScript source today, the native Rust crates and the wasm builds as the port proceeds) runs the same cases, so a port is correct when it passes what the original passes.

## Layout

```
conformance/
  README.md                  this file
  case.schema.json           JSON Schema of a corpus file
  manifest.json              what the corpus holds
  manifest.schema.json       JSON Schema of the manifest
  <kind>/<name>.json         the cases
  fixtures/                  data the runners test themselves with
```

The files are UTF-8 (a loader refuses a file that is not, rather than reading replacement characters) and canonical JSON: keys sorted, two-space indent, one element per line. The examples below show the fields in reading order and the files do not.

### Which files are corpus files

Every loader applies this one rule, and each runs it over `fixtures/loader-selection` (a tree, the files it must select and the entries it must refuse) so the loaders cannot disagree:

- A name that starts with a dot is ignored, at any depth.
- A directory called `fixtures`, `schema` or `runner` is skipped, at any depth, directly under the root included. It holds data cases refer to or the runners themselves, never cases.
- A name is lower-case ASCII letters, digits, dots, hyphens and underscores, and starts with a letter or digit, so every loader orders names the same way. The root's own files are the exception. A name that is not is a failure.
- A corpus file is a `.json` file at `<kind>/<name>.json`. The directory names the case kind it holds, and a file takes its name from the module or test file it was extracted from (`display-name.json` from `display-name.unit.test.ts`).
- The root holds only `README.md`, `case.schema.json`, `manifest.json` and `manifest.schema.json` as files.
- Files and problems are listed in UTF-16 code unit order, directory by directory.
- Anything else, a stray file, a file of another type, a file or directory at another depth, is a failure in every loader, never ignored by one.

### The manifest

`manifest.json` records, for every corpus file, its case count and the ids of the cases marked for one implementation only, in ascending order. Every runner checks the corpus against it and fails on any difference. A runner also counts the cases it executes and the cases it skips, and asserts that the sum is the manifest's total and that every case it skips because it is marked is marked in the manifest. A case marked for the other implementation is one it executes. The TypeScript runner counts the cases it registers when it collects them, so the check holds whatever the run does with the registered tests (a name filter, a bail, a retry, a shuffled order). The Rust loader executes no case yet: it skips the cases marked `rust` because they are marked, every other case because no native executor exists, and makes the same assertions; execution moves cases from the second kind of skip to executed and cannot lose one.

## Cases

Every case has:

- `id`: unique across the whole corpus, in lower-case ASCII letters, digits, dots, hyphens and underscores.
- `from`: either `<test file>.test.ts: <describe> > <test>` (or `.test.tsx`), the original test title the case came from, so a failure points back to the behaviour it pinned, or `recorded: <source file> (<what>)` for a recorded case. The schema and every loader refuse a `from` in neither form. Where the original asserted less than the case records, the case records more and nothing is lost.
- `kind`: selects the shape below, and equals the name of the directory the file is in.
- `only`, optional, with a `reason` that says why: `ts` for a case the TypeScript implementation skips, `rust` for a case the Rust implementation skips. The axis is the implementation, never the host: a wasm build of the Rust code is `rust` wherever it runs (native, Node, a browser or Workers). A case one implementation cannot run carries it; nothing else does. A `reason` without `only` is refused.

A case comes from an existing test, with the same inputs and an expectation never weaker than the original's. The exception is a recorded case: one written for the corpus because no test covered the behaviour, or because the original asserted only that a result contained a fragment and the case pins the whole result. Its expectation is what the TypeScript implementation does today and its `from` starts `recorded:`, so a reader can tell a pinned original from a recorded behaviour. A recorded behaviour that is a defect is fixed and its case changed together, never left pinned.

### Values and text

A value in `args`, `expect`, `expectSubset` and `input` is any JSON value, with two restrictions that make it the same value in every implementation:

- Integers are at most 2^53-1 in magnitude, the largest the JavaScript runners hold exactly, and a number is always an integer: an integer written `97.0` is the integer 97, as in JSON Schema, and `97.5` is refused. A quantity that is not an integer is written as a string.
- A string is a sequence of UTF-16 code units, and every `index` or length counts them, which is what the TypeScript implementation does. A string is written either as a JSON string, which must be well-formed Unicode (no unpaired surrogate escape), so every loader can read it, or as an object holding only `codeUnits`: `{ "codeUnits": [<0..65535>, ...] }`, for content a JSON string cannot carry, an unpaired surrogate. An object with a `codeUnits` key that is anything else is refused.

A loader reads both forms into the same code unit sequence; `fixtures/text-forms/pairs.json` lists texts with their code units, and every loader checks they agree. A loader that reads a string in scalar values or bytes is wrong: `😀` is two code units.

### `function`

```json
{ "id": "...", "from": "...", "kind": "function", "function": "display-name.shortId", "args": ["0123456789abcdef"], "expect": "0123456789ab" }
```

`function` names a pure function of its arguments, as `<module>.<name>`, in the implementation's own call table; a name the call table does not hold fails the case. `args` are the arguments in order, and an optional argument that is absent is left off the end or, where a later one is given, written `null`. A function that takes something JSON cannot carry (a set, a map, a callback, a store) is called through an entry in the call table that builds it from the case's data, and the case says what the data is, never how the entry builds it. Exactly one of these says what the call does:

- `expect`: it returns a value equal to this one. Objects compare without regard to key order, and an absent key and a key holding `undefined` are the same.
- `expectSubset`: it returns a value that contains this one. An object matches when every key it gives matches; an array matches element by element and has the same length; any other value must be equal.
- `expectUndefined`: `true`, it returns nothing.
- `throws`: it fails. `code` names the error's own code where it has one, and `message` is a list of texts (fragments) that must all occur in the error message, in order, each after the end of the one before.

A function that is asynchronous is awaited.

### `validate`

```json
{ "id": "...", "from": "...", "kind": "validate", "schema": "tool-params", "input": { "action": "whoami" }, "expect": { "ok": true } }
```

`schema` names a validator in the implementation's call table. `expect` is `{ "ok": true }`, with an optional `value`, the value the validator returns, or `{ "ok": false, "issues": [ { "path": [...], "message": [...] } ] }`: every issue the validator reports, in order. `path` is the keys and indexes from the root to the value at fault, and `message`, optional, is a list of fragments as in `throws`.

### Rules the schema cannot express

Each loader enforces these beside the schema:

- A case id is not used twice, within a file or across files.
- A case's `kind` is the name of its directory.
- A manifest's `only` lists are in ascending order, without repeats.
- The corpus matches the manifest.

Every rule above has a negative fixture, and every negative fixture has a repaired twin of the same name that differs by that one defect and is valid, so a fixture cannot stay rejected for another reason: each loader asserts both. A rule about one file has a file in `fixtures/invalid-cases` (twin in `fixtures/repaired-cases`); a rule about the manifest has a file in `fixtures/manifests/invalid` (twin in `fixtures/manifests/repaired`); a rule across files, or between the corpus and its manifest, has a whole corpus root in `fixtures/corpora/invalid` (twin in `fixtures/corpora/repaired`), loaded the way the real corpus is. `fixtures/valid-cases` and `fixtures/manifests/valid` hold files every loader must accept, the bounds of every number among them. A file a loader cannot parse counts as rejected, which is how a loader meets an unpaired surrogate escape. Every real corpus file must be accepted by all of them. A rule added to the format gets a fixture and its twin in the same commit.

## Adding a case

Add it to the file for the module it belongs to, with a fresh `id`, update `manifest.json`, and run the corpus (`pnpm test` runs the TypeScript runner, and `sh scripts/rust.sh test` loads and checks every file in the Rust workspace). When a behaviour changes on purpose, change the case in the same commit as the code.
