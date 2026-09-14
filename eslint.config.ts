import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "eslint/config";
import type { Rule } from "eslint";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintPluginPrettier from "eslint-plugin-prettier";
import tseslint from "typescript-eslint";

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

// ─── Custom rules ────────────────────────────────────────────────────────────

const noPointlessReassignments: Rule.RuleModule = {
  meta: {
    type: "problem",
    messages: {
      pointlessReassignment:
        "Pointless reassignment. {{ name }} is just an alias for {{ value }}. Use the original directly instead.",
    },
  },
  create(context) {
    return {
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || node.init?.type !== "Identifier") {
          return;
        }
        if (node.id.name.startsWith("_")) {
          return;
        }
        // A `let`/`var` binding can be legitimately reassigned later (e.g. a loop-mutated value initialised from a starting constant, then updated each iteration) -- only `const` genuinely guarantees the binding is nothing but a permanent alias for its initializer, since a `const` can never be written to again. Without this check the rule fired on exactly that pattern (`let delayMs = INITIAL_RETRY_DELAY_MS` ahead of a loop that reassigns `delayMs` every iteration), which is not a pointless reassignment at all.
        if (
          node.parent.type === "VariableDeclaration" &&
          node.parent.kind !== "const"
        ) {
          return;
        }
        context.report({
          node,
          messageId: "pointlessReassignment",
          data: {
            name: node.id.name,
            value: node.init.name,
          },
        });
      },
    };
  },
};

const customPlugin = {
  rules: {
    "no-pointless-reassignments": noPointlessReassignments,
  },
};

// ─── Config ──────────────────────────────────────────────────────────────────

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
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
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
      custom: customPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "custom/no-pointless-reassignments": "error",
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
      "max-lines": [
        "error",
        { max: 800, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  eslintConfigPrettier,
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
    language: "json/json",
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
