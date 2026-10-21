export default {
  // Declaration files are generated, so they are not linted.
  "src/**/*.{ts,tsx}": (files: readonly string[]) => {
    const sources = files.filter((file) => !file.endsWith(".d.ts"));

    return sources.length === 0
      ? []
      : [
          `eslint --cache --fix ${sources.map((file) => JSON.stringify(file)).join(" ")}`,
        ];
  },
  "scripts/**/*.ts": "eslint --cache --fix",
  "*.config.ts": "eslint --cache --fix",
};
