# Conformance corpus

Language-neutral cases that pin the behaviour of agent-comms. Every implementation (the TypeScript source, the native Rust crates and the wasm builds) runs the same cases, so a port is correct when it passes what the original passes.

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

The files are UTF-8 (a loader refuses a file that is not, rather than reading replacement characters) and canonical JSON: two-space indent, one element per line, and the keys of every object in UTF-16 code unit order (below), which every loader checks against the file's own text. The examples below show the fields in reading order and the files do not.

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

`manifest.json` records, for every corpus file, its case count and the ids of the cases carrying `skip`, in ascending order. Every runner checks the corpus against it and fails on any difference. A runner also counts the cases it executes and the cases it skips, and asserts that the sum is the manifest's total and that every case it skips because it carries `skip` is listed in the manifest. A case that skips the other implementation is one it executes. The TypeScript runner records each case where it registers it and again where its body starts, and compares both with the manifest, so a loop that registers fewer cases than the manifest holds, or a framework that skips them, fails the check, and so does a run that selects tests by name or stops early. The Rust loader selects, validates and counts the corpus and executes no case: it counts the cases carrying `skip: rust` as skipped because they do and every other case as skipped for want of a native executor, and makes the same assertions, so a case an executor takes over moves from the second count to executed and is never lost.

## Cases

Every case has:

- `id`: unique across the whole corpus, in lower-case ASCII letters, digits, dots, hyphens and underscores.
- `from`: either `<test file>.test.ts: <describe> > <test>` (or `.test.tsx`), the original test title the case came from, so a failure points back to the behaviour it pinned, or `recorded: <source file> (<what>)` for a recorded case. The schema and every loader refuse a `from` in neither form. Where the original asserted less than the case records, the case records more and nothing is lost.
- `kind`: selects the shape below, and equals the name of the directory the file is in.
- `skip`, optional, with a `reason` that says why: the implementation that does not run the case, `ts` for a case the TypeScript implementation skips and `rust` for a case the Rust implementation skips. The axis is the implementation, never the host: a wasm build of the Rust code is `rust` wherever it runs (native, Node, a browser or Workers). A case one implementation cannot run in any build carries it; nothing else does. A number JSON cannot write, an infinity or a NaN, is no reason to skip: it is written as `{ "$number": "Infinity" }` (below) and runs in every implementation. A `reason` without `skip` is refused.

A case comes from an existing test, with the same inputs and an expectation never weaker than the original's. Where the original asserted only that a result contained a fragment, the case pins the whole result as the TypeScript implementation returns it, so it holds every original assertion and more, and its `from` still names the original test. A case written for behaviour no test covered is a recorded case: its expectation is what the TypeScript implementation does today, it stands for no deleted assertion, and its `from` starts `recorded:` so a reader can tell a pinned original from a recorded behaviour. A recorded behaviour that is a defect is fixed and its case changed together, never left pinned.

### Values and text

A value in `args`, `expect`, `expectSubset` and `input` is any JSON value, with these restrictions that make it the same value in every implementation:

- Integers are at most 2^53-1 in magnitude, the largest the JavaScript runners hold exactly, and a number is always an integer: an integer written `97.0` is the integer 97, as in JSON Schema, and `97.5` is refused. A quantity that is not an integer is written as a string. The four numbers the canonical form cannot hold are written `{ "$number": "-0" }` (the canonical form writes a negative zero as `0`), `"Infinity"`, `"-Infinity"` and `"NaN"`, wherever a case has a value. Every implementation reads them through a closed lookup of those four names, as the numbers they name, and a case that has one runs in all of them; any other name, or any other key beside `$number`, is refused.
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

`schema` names a validator in the implementation's call table. `expect` is `{ "ok": true }`, with an optional `value`, the value the validator returns, or `{ "ok": false, "issues": [ { "path": [...], "message": [...] } ] }`: every issue the validator reports, in order. `path` is the keys and indexes from the root to the value at fault, `code`, optional, is the validator's own name for the kind of problem, and `message`, optional, a list of fragments as in `throws`. A validator's wording belongs to its library, so a case asserts paths and codes, and a message only where a caller shows it to a user.

### Rules the schema cannot express

Each loader enforces these beside the schema:

- The keys of every object in a corpus file or the manifest are in UTF-16 code unit order, each after the one before and none repeated. Integer-like keys are ordered as the strings they are (`"10"` before `"9"`), not numerically as `JSON.parse` shows them, so the check reads the text and not the parsed value, and a key holding an unpaired surrogate is refused.
- A case id is not used twice, within a file or across files.
- A case's `kind` is the name of its directory.
- A manifest's `skip` lists are in ascending order, without repeats.
- The corpus matches the manifest.

Every rule above has a negative fixture, and every negative fixture has a repaired twin of the same name that differs by that one defect and is valid, so a fixture cannot stay rejected for another reason: each loader asserts both. A rule about one file has a file in `fixtures/invalid-cases` (twin in `fixtures/repaired-cases`); a rule about the manifest has a file in `fixtures/manifests/invalid` (twin in `fixtures/manifests/repaired`); a rule across files, or between the corpus and its manifest, has a whole corpus root in `fixtures/corpora/invalid` (twin in `fixtures/corpora/repaired`), loaded the way the real corpus is. `fixtures/valid-cases` and `fixtures/manifests/valid` hold files every loader must accept, the bounds of every number among them. A file a loader cannot parse counts as rejected, which is how a loader meets an unpaired surrogate escape. Every real corpus file must be accepted by all of them. A rule added to the format gets a fixture and its twin in the same commit.

## Tests kept in TypeScript

A test in an area the corpus covers that stays a TypeScript test is listed here with the reason it cannot be a case. The areas are the modules the corpus has cases for, and a test file named after one of them, or named in this table, is held to the table in both directions with exact titles: a test with no row fails, and a row whose test does not exist fails. A title is the names of the enclosing blocks and the test's own, joined by ` > `.

| File | Test | Reason |
| --- | --- | --- |
| `src/test/claude-command.unit.test.ts` | `hooks/drain.sh > matches the process forms the bridge matches` | `file` |
| `src/test/error-reporting.unit.test.ts` | `createMeshErrorReporter > writes to the real process stderr by default` | `process` |
| `src/test/version-report-actions.unit.test.ts` | `formatSelfVersionLines / formatSelfVersionSuffix > includes only the wire-mesh-core line when no cc-peer getter is wired` | `process` |
| `src/test/version-report-actions.unit.test.ts` | `formatSelfVersionLines / formatSelfVersionSuffix > includes a cc-peer line/suffix once a getter answers one` | `process` |
| `src/test/version-report-actions.unit.test.ts` | `formatListedAgentVersions > reads local versions for the requester's own entry, ignoring the store's peer getters` | `process` |
| `src/bridges/user/web/test/web-access.unit.test.ts` | `generateAccessToken > generates distinct tokens` | `random` |
| `src/bridges/user/web/test/web-access.unit.test.ts` | `generateAccessToken > generates a token that matches itself` | `random` |
| `src/bridges/user/web/test/web-access.unit.test.ts` | `authorise > accepts this machine's own hostname as the Host` | `process` |
| `src/test/peer-link-error.integration.test.ts` | `WireMeshTransport dial failures > a refused dial is reported as a PeerLinkError carrying ECONNREFUSED` | `socket` |

The reasons:

- `file`: the test reads a file of this repository, which a language-neutral case cannot name.
- `process`: the test depends on the running process, its own package and dependency versions, its standard error or this machine's hostname.
- `random`: the result differs on every call.
- `socket`: the test needs a real network socket.

## Adding a case

Add it to the file for the module it belongs to, with a fresh `id`, update `manifest.json`, and run the corpus (`pnpm test` runs the TypeScript runner, and `sh scripts/rust.sh test` loads and checks every file in the Rust workspace). When a behaviour changes on purpose, change the case in the same commit as the code.
