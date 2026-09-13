import type { PartialStrykerOptions } from "@stryker-mutator/api/core";

// A real .ts file, not stryker.config.mjs with a `@type` JSDoc annotation: Stryker's own config loader is a plain `import()` under the hood with no opinion about the extension it's given, and Node's own ESM loader strips a .ts file's type syntax natively on this workspace's runtime, so `stryker run stryker.config.ts` resolves straight through that support with no shim file.
//
// testRunner is "command", not "@stryker-mutator/vitest-runner", despite this repo's own test script now running on vitest: vitest-runner@10.0.0 crashes on init against vitest@5.0.0 with "TypeError: Converting circular structure to JSON" while serialising vitest's own resolved config, a confirmed upstream incompatibility with no fix or compatible version pairing available (see wire-mesh-core's own stryker.config.ts, which hit the identical crash first). The command runner re-runs `pnpm test` as a subprocess per mutant instead of driving vitest in-process, so it loses per-test coverage analysis (every mutant re-runs the entire suite rather than only its covering tests) but actually produces a real result. Revisit once vitest-runner ships a fix. No separate build step is needed first: the test script already runs directly against .ts source, so Stryker's own instrumented sandbox copy is tested exactly the way a real run is, with nothing to keep in sync between a build and a test step.
const config: PartialStrykerOptions = {
  packageManager: "pnpm",
  // Scoped to the three files the issue that added this config actually names, not the whole of src/core/: identity.ts, mesh-store.ts, and wire-mesh-transport.ts are the branch-heavy, security-relevant code a green suite can still be hiding an untested condition in. The rest of src/core/ (discovery, federation, push, bridge wiring) is exercised by its own integration tests and out of scope for this pass -- narrower than the glob this config originally shipped with, which matched every file under src/core/ despite this same comment always having named only these three.
  mutate: [
    "src/core/identity.ts",
    "src/core/mesh-store.ts",
    "src/core/wire-mesh-transport.ts",
  ],
  testRunner: "command",
  commandRunner: {
    command: "npx vitest run",
  },
  plugins: ["@stryker-mutator/typescript-checker"],
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  // The default (true) batches multiple mutants into one compiler check for speed, but a batched check can produce a TypeScript diagnostic Stryker can't attribute back to any single file, which throws a hard, run-ending StrykerError rather than degrading gracefully -- hit for real on this exact config partway through a baseline run. Checking mutants individually costs more wall-clock time but is the only way to avoid that crash mode entirely.
  typescriptChecker: {
    prioritizePerformanceOverAccuracy: false,
  },
  // The command runner only sees the subprocess's exit code, never which tests ran -- there's no per-test signal to analyse coverage from, so Stryker itself forces this to "off" for this runner regardless of what's configured here.
  coverageAnalysis: "off",
  incremental: true,
  // dist/coverage/.turbo are build/tooling output Stryker would otherwise copy into every mutant's own sandbox for nothing -- none of it is ever read by a test run against source.
  ignorePatterns: ["dist", "coverage", ".turbo", "node_modules"],
  reporters: ["progress", "clear-text", "html"],
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  concurrency: 4,
  // This repo's own real integration tests (full mesh e2e, federation, room-send-retry) genuinely take real wall-clock seconds each against real TLS/WebSocket connections -- generous on purpose since the whole suite re-runs once per mutant under the command runner.
  timeoutMS: 60_000,
  // Distinct from timeoutMS above (which bounds each individual mutant's test run once a baseline net time is known): this is the absolute timeout for Stryker's own initial, unmutated dry run, defaulting to 5 minutes. That default was hit for real on a genuinely shared, heavily-loaded machine, where the full suite's live TCP/TLS integration tests took over 5 minutes to complete once even with no mutation applied at all.
  dryRunTimeoutMinutes: 15,
  thresholds: {
    high: 80,
    low: 60,
    // No `break` yet -- this config's own job is a first baseline report (agent-comms#63); fixing what it finds and setting a real, measured break threshold is agent-comms#64's own separate work. Picking a break value before a baseline exists would be exactly the arbitrary-magic-number pattern this codebase's own no-magic-numbers convention refuses.
  },
};

export default config;
