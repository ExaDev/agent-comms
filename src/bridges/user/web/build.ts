/**
 * Build script — bundles the frontend into a single HTML string.
 *
 * Reads index.html, bundles main.ts with esbuild (inlining CSS),
 * then generates a TypeScript file exporting FRONTEND_HTML.
 *
 * Output: src/bridges/user/web/generated-html.ts (committed, rebuilt on pnpm build)
 *
 * Usage: pnpm build:frontend
 */

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.join(__dirname, "frontend");
const OUT_PATH = path.join(__dirname, "generated-html.ts");

/**
 * esbuild plugin to inline CSS as a side-effect import.
 * Replaces `import "./styles.css"` with a <style> injection at runtime.
 */
const inlineCssPlugin: esbuild.Plugin = {
  name: "inline-css",
  setup(build) {
    build.onResolve({ filter: /\.css$/ }, (args) => {
      return {
        path: path.resolve(args.resolveDir, args.path),
        namespace: "inline-css",
      };
    });

    build.onLoad({ filter: /.*/, namespace: "inline-css" }, async (args) => {
      const css = await fs.promises.readFile(args.path, "utf8");
      const escaped = JSON.stringify(css);
      return {
        contents: `document.head.appendChild(Object.assign(document.createElement("style"), { textContent: ${escaped} }));`,
        loader: "js",
      };
    });
  },
};

async function main(): Promise<void> {
  // Bundle JS + CSS
  const result = await esbuild.build({
    entryPoints: [path.join(FRONTEND_DIR, "main.ts")],
    bundle: true,
    minify: true,
    target: "es2020",
    format: "iife",
    write: false,
    plugins: [inlineCssPlugin],
  });

  const files = result.outputFiles;
  const first = files[0];
  if (!first) {
    throw new Error("esbuild produced no output");
  }
  const jsBundle = first.text;

  // Read HTML shell
  const htmlPath = path.join(FRONTEND_DIR, "index.html");
  const html = fs.readFileSync(htmlPath, "utf-8");

  // Inject JS into HTML
  const fullHtml = html.replace(
    "</body>",
    `  <script>\n${jsBundle}\n  </script>\n</body>`,
  );

  // Escape for TypeScript string literal
  const escaped = fullHtml
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");

  // Generate TypeScript file
  const output = `/**
 * GENERATED FILE — do not edit.
 * Rebuild with: pnpm build:frontend
 */

export const FRONTEND_HTML = \`${escaped}\`;
`;

  fs.writeFileSync(OUT_PATH, output, "utf-8");
  console.log(`Built frontend: ${OUT_PATH}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
