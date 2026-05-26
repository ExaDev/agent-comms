/**
 * Build script — bundles the Preact frontend into web/dist/bundle.js.
 *
 * esbuild compiles main.tsx (with inlined CSS) into a single JS bundle.
 * The server loads bundle.js and index.html into memory at startup.
 *
 * Usage: pnpm build:frontend
 */

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.join(__dirname, "frontend");
const DIST_DIR = path.join(__dirname, "dist");

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
  fs.mkdirSync(DIST_DIR, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(FRONTEND_DIR, "main.tsx")],
    bundle: true,
    minify: true,
    target: "es2020",
    format: "iife",
    outfile: path.join(DIST_DIR, "bundle.js"),
    plugins: [inlineCssPlugin],
    jsx: "automatic",
    jsxImportSource: "preact",
  });

  // Build the service worker as a separate bundle.
  // Service workers run in a separate context with no DOM access,
  // so this is intentionally a standalone IIFE with no imports.
  await esbuild.build({
    entryPoints: [path.join(FRONTEND_DIR, "sw.ts")],
    bundle: true,
    minify: true,
    target: "es2020",
    format: "iife",
    outfile: path.join(DIST_DIR, "sw.js"),
  });

  console.log(`Built frontend: ${DIST_DIR}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
