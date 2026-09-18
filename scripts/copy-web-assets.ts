/**
 * Copy the built web frontend assets into the compiled output tree.
 *
 * `build:frontend` (Vite) emits the transformed index.html, JS bundle, service worker, mesh worker, manifest and icons into `src/bridges/user/web/dist/`. `tsc` only emits JS/d.ts from `.ts` inputs, so these non-TS assets are never copied into the top-level `dist/`. Without this step the published package is missing `dist/index.html`, `dist/bundle.js`, `dist/sw.js`, `dist/manifest.json` and `dist/icons/*`, and the web server crashes with ENOENT at module load — taking down every command, including setup. See #18.
 *
 * Usage: node/tsx scripts/copy-web-assets.ts (run after `tsc`)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webSrc = path.join(root, "src", "bridges", "user", "web");
const webOut = path.join(root, "dist", "bridges", "user", "web");

// Vite's full build output: index.html, bundle.js, sw.js, mesh-worker.js, manifest.json, icons/*. cpSync creates the destination dir itself.
fs.cpSync(path.join(webSrc, "dist"), path.join(webOut, "dist"), {
  recursive: true,
});

console.log(`Copied web assets to ${webOut}`);
