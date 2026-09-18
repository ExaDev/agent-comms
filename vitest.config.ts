import { defineConfig, defaultExclude } from "vitest/config";

export default defineConfig({
  oxc: false,
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
    setupFiles: ["src/bridges/user/web/frontend/test/vitest-setup.ts"],
    exclude: [
      ...defaultExclude,
      // Compiled output of the *.test.ts sources vitest already runs -- vitest 5's defaultExclude no longer excludes dist/ on its own.
      "**/dist/**",
      // Playwright's own e2e suite lives under src/bridges/user/web/e2e and is driven by `pnpm test:e2e`, not vitest -- its *.e2e.test.ts files would otherwise also match vitest's default **/*.test.ts discovery glob.
      "src/bridges/user/web/e2e/**",
      // Stryker's own instrumented sandbox copies of the source (each mutant gets a full copy under .stryker-tmp/sandbox-*/), including its own nested copy of the e2e suite above -- the exclude pattern for that suite only matches the real src/ path, not this prefixed one, so running `pnpm test` (e.g. via the pre-push hook) while a mutation run's sandbox exists on disk picks up Playwright's own e2e tests and fails on `test.describe()` being called outside a Playwright config. Matches the same exclusion eslint.config.ts's `ignores` and stryker.config.ts's own `ignorePatterns` already carry, for the identical reason.
      ".stryker-tmp/**",
    ],
  },
});
