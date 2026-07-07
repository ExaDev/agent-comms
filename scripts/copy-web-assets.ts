/**
 * Copy the built web frontend assets into the compiled output tree.
 *
 * `build:frontend` (esbuild) emits the bundles into
 * `src/bridges/user/web/dist/`, and `index.html` lives alongside the frontend
 * sources. `tsc` only emits JS/d.ts from `.ts` inputs, so these non-TS assets
 * are never copied into the top-level `dist/`. Without this step the published
 * package is missing `frontend/index.html`, `dist/bundle.js`, `dist/sw.js`,
 * `dist/manifest.json` and `dist/icons/*`, and the web server crashes with
 * ENOENT at module load — taking down every command, including setup. See #18.
 *
 * Usage: node/tsx scripts/copy-web-assets.ts (run after `tsc`)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webSrc = path.join(root, "src", "bridges", "user", "web");
const webOut = path.join(root, "dist", "bridges", "user", "web");

// Frontend shell (loaded by the server as INDEX_HTML). cpSync creates the
// destination parent dir itself.
fs.cpSync(
  path.join(webSrc, "frontend", "index.html"),
  path.join(webOut, "frontend", "index.html"),
);

// esbuild bundles + web app manifest + PWA icons.
fs.cpSync(path.join(webSrc, "dist"), path.join(webOut, "dist"), {
  recursive: true,
});

console.log(`Copied web assets to ${webOut}`);
