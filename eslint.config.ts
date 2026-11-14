import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "eslint/config";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintPluginPrettier from "eslint-plugin-prettier";
import exadev from "@exadev/eslint-config";

/** The corpus fixtures, in both the invalid and the repaired directory, whose exact bytes matter. */
const RAW_CORPUS_FIXTURES = [
  "file-not-utf8.json",
  "file-with-byte-order-mark.json",
  "text-lone-surrogate-escape.json",
  "integer-written-as-float-one-past-2-53.json",
  "keys-out-of-order.json",
  "key-repeated.json",
  "integer-like-keys-in-numeric-order.json",
  "astral-key-before-private-use-key-by-code-point.json",
  "key-with-lone-surrogate-escape.json",
  "nesting-one-past-the-maximum-depth.json",
];

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
      // The selection tree holds placeholder text, and the raw fixtures are written byte for byte because what they pin is the text itself: a file that is not UTF-8, a byte order mark, a lone surrogate escape, a number with more digits than its canonical form keeps, and keys out of canonical order. None is canonical JSON.
      "conformance/fixtures/loader-selection/tree/**",
      ...RAW_CORPUS_FIXTURES.flatMap((name) => [
        `conformance/fixtures/invalid-cases/${name}`,
        `conformance/fixtures/repaired-cases/${name}`,
      ]),
      "conformance/fixtures/manifests/invalid/files-out-of-order.json",
      "conformance/fixtures/manifests/repaired/files-out-of-order.json",
    ],
  },
  ...exadev,
  // Several directories under src/ use index.ts as a real module (interfaces, functions, a default export), not a re-export barrel -- barrel-policy only restricts files that actually contain re-exports, so this override is scoped to permitting the pattern, not to exempting those files from anything they weren't already going to pass. src/core/index.ts is a genuine re-export barrel and the package's own entry point; every one of its re-exports comes from a direct sibling (confirmed directly), so 'siblings' -- not 'single', which only ever recognises the literal path src/index.ts -- is the mode that actually matches this repo's real layout. Scoped to TS/TSX: the exadev plugin namespace is only registered on the JS/TS-scoped config objects @exadev/eslint-config's own array contributes, so an unscoped override here would fail to resolve "exadev/barrel-policy" while linting a JSON or Markdown file.
  {
    files: ["**/*.{ts,tsx}"],
    rules: { "exadev/barrel-policy": ["error", { mode: "siblings" }] },
  },
  // @exadev/eslint-config auto-wires eslint-plugin-react once it's a devDependency, but doesn't set its own React version -- without this, every lint run prints "React version not specified in eslint-plugin-react settings" even though nothing is actually misconfigured. `version: "detect"` crashes outright ("contextOrFilename.getFilename is not a function") -- eslint-plugin-react 7.37.5's detection codepath calls a context method ESLint 10's flat-config rule context no longer exposes the way it expects -- so this pins the installed react version explicitly instead; bump it when react's own version bumps.
  {
    files: ["**/*.{ts,tsx}"],
    settings: { react: { version: "19.3.0" } },
  },
  // The frontend's own React component tests (rendering + user-interaction simulation via @testing-library/react) are a genuinely different kind of test from a plain unit test of a pure module -- deliberately named with their own '.component.test.tsx' suffix rather than folded into '.unit.', so exadev/test-file-kind's own default kinds list is extended here rather than relabelling that existing, meaningful distinction away.
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "exadev/test-file-kind": [
        "error",
        { kinds: ["unit", "integration", "e2e", "component"] },
      ],
    },
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
        {
          message:
            "localeCompare orders by the host's locale and collation data. Use compareCodeUnits (ids, keys, timestamps) or compareDisplayNames (names a person reads) from core/ordering.ts.",
          selector: "CallExpression[callee.property.name='localeCompare']",
        },
      ],
      "prettier/prettier": "error",
      "@typescript-eslint/require-await": "warn",
    },
  },
  eslintConfigPrettier,
  {
    // Code that ships must not import test material: a test directory, a helper, a runner or a setup module. The tarball leaves those out, so such an import would fail only once installed, and the packaging check names files, not imports.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "**/test/**",
      "**/*.test.{ts,tsx}",
      "**/*.helper.ts",
      "**/*.runner.ts",
      "**/*.setup.ts",
      "src/bridges/user/web/e2e/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/test/**",
                "**/*.helper.js",
                "**/*.runner.js",
                "**/*.setup.js",
              ],
              message:
                "Shipped code does not import test material, which the package does not publish.",
            },
          ],
        },
      ],
    },
  },
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
    ignores: ["turbo.json", "**/tsconfig*.json"],
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
