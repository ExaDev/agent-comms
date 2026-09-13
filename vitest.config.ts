import { defineConfig, defaultExclude } from "vitest/config";

export default defineConfig({
  oxc: false,
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  test: {
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
    exclude: [
      ...defaultExclude,
      // Compiled output of the *.test.ts sources vitest already runs -- vitest 5's defaultExclude no longer excludes dist/ on its own.
      "**/dist/**",
      // Playwright's own e2e suite lives under src/bridges/user/web/e2e and is driven by `pnpm test:e2e`, not vitest -- its *.e2e.test.ts files would otherwise also match vitest's default **/*.test.ts discovery glob.
      "src/bridges/user/web/e2e/**",
    ],
  },
});
