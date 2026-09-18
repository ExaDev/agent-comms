import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "eslint/config";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintPluginPrettier from "eslint-plugin-prettier";
import exadev from "@exadev/eslint-config";

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig(
  {
    // .stryker-tmp holds Stryker's own instrumented sandbox copies of the source (each mutant gets a full copy, deliberately carrying a @ts-nocheck pragma Stryker injects itself) -- linting them produces thousands of irrelevant errors against generated, throwaway code, not anything committed. reports/ is Stryker's own output (HTML/JSON), same reasoning.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/pnpm-lock.yaml",
      ".stryker-tmp/**",
      "reports/**",
    ],
  },
  ...exadev,
  // Several directories under src/ use index.ts as a real module (interfaces, functions, a default export), not a re-export barrel -- barrel-policy only restricts files that actually contain re-exports, so this override is scoped to permitting the pattern, not to exempting those files from anything they weren't already going to pass. src/core/index.ts is a genuine re-export barrel and the package's own entry point; every one of its re-exports comes from a direct sibling (confirmed directly), so 'siblings' -- not 'single', which only ever recognises the literal path src/index.ts -- is the mode that actually matches this repo's real layout. Scoped to TS/TSX: the exadev plugin namespace is only registered on the JS/TS-scoped config objects @exadev/eslint-config's own array contributes, so an unscoped override here would fail to resolve "exadev/barrel-policy" while linting a JSON or Markdown file.
  {
    files: ["**/*.{ts,tsx}"],
    rules: { "exadev/barrel-policy": ["error", { mode: "siblings" }] },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.ts",
            "release.config.ts",
            "commitlint.config.ts",
            "lint-staged.config.ts",
            "playwright.config.ts",
            "vitest.config.ts",
            "stryker.config.ts",
            "scripts/*.ts",
            "src/bridges/user/web/e2e/*.ts",
            "src/bridges/user/web/frontend/test/*.ts",
            "src/bridges/user/web/frontend/test/*.tsx",
          ],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 50,
        },
        tsconfigRootDir,
      },
    },
    plugins: {
      prettier: eslintPluginPrettier,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          message:
            "Dynamic imports are forbidden — use static imports instead.",
          selector: "ImportExpression",
        },
        {
          message:
            "Inline type imports via import() are forbidden — use a static import instead.",
          selector: "TSImportType",
        },
      ],
      "prettier/prettier": "error",
      "@typescript-eslint/require-await": "warn",
    },
  },
  eslintConfigPrettier,
  {
    // Playwright's fixture-dependency resolution parses each fixture function's own source text, requiring its first parameter to be a literal object-destructuring pattern even when the fixture depends on nothing -- a plain identifier throws "First argument must use the object destructuring pattern" at runtime, so the empty `{}` here is Playwright's own API contract, not a code smell.
    files: ["src/bridges/user/web/e2e/fixtures.ts"],
    rules: { "no-empty-pattern": "off" },
  },
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.e2e.test.ts",
      "**/*.spec.ts",
      "**/test/*.helper.ts",
    ],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/consistent-type-assertions": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/non-nullable-type-assertion-style": "off",
    },
  },
  {
    files: ["**/*.json"],
    ignores: ["turbo.json"],
    language: "json/json",
    plugins: { json },
    rules: {
      "json/no-duplicate-keys": "error",
    },
  },
  {
    // turbo.json's own task definitions carry non-obvious WHY-comments (cache exclusions, deliberately uncached tasks) -- JSONC, not strict JSON, so those survive.
    files: ["turbo.json"],
    language: "json/jsonc",
    plugins: { json },
    rules: {
      "json/no-duplicate-keys": "error",
    },
  },
  {
    files: ["**/*.md"],
    language: "markdown/gfm",
    plugins: { markdown },
    rules: {
      "markdown/no-html": "off",
    },
  },
);
