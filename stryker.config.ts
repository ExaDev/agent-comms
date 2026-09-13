import type { PartialStrykerOptions } from "@stryker-mutator/api/core";

// A real .ts file, not stryker.config.mjs with a `@type` JSDoc annotation: Stryker's own config loader is a plain `import()` under the hood with no opinion about the extension it's given, and Node's own ESM loader strips a .ts file's type syntax natively on this workspace's runtime, so `stryker run stryker.config.ts` resolves straight through that support with no shim file.
//
// testRunner is "command", not a native runner integration: this repo's own test script (`tsx --test --test-concurrency=1 'src/test/**/*.test.ts'`) runs node's built-in test runner directly against TS source via tsx, not vitest/jest/mocha, so there's no official Stryker runner plugin to reach for. The command runner re-runs the whole test command as a subprocess per mutant instead of driving the runner in-process, so it loses per-test coverage analysis (every mutant re-runs the entire suite rather than only its covering tests) but works correctly against any test command at all. No separate build step is needed first: the test script already runs directly against .ts source, so Stryker's own instrumented sandbox copy is tested exactly the way a real run is, with nothing to keep in sync between a build and a test step.
const config: PartialStrykerOptions = {
  packageManager: "pnpm",
  // Scoped to src/core/ specifically, per the issue that added this config: identity, mesh-store, and transport are the branch-heavy, security-relevant code a green suite can still be hiding an untested condition in. src/bridges/ (harness-specific wiring, exercised by its own integration tests) and src/test/ itself are out of scope for this first pass.
  mutate: ["src/core/**/*.ts", "!src/core/**/*.test.ts"],
  testRunner: "command",
  commandRunner: {
    command: "npx tsx --test --test-concurrency=1 'src/test/**/*.test.ts'",
  },
  plugins: ["@stryker-mutator/typescript-checker"],
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
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
  thresholds: {
    high: 80,
    low: 60,
    // No `break` yet -- this config's own job is a first baseline report (agent-comms#63); fixing what it finds and setting a real, measured break threshold is agent-comms#64's own separate work. Picking a break value before a baseline exists would be exactly the arbitrary-magic-number pattern this codebase's own no-magic-numbers convention refuses.
  },
};

export default config;
