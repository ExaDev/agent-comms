/**
 * Vite build config for the web bridge frontend.
 *
 * Builds main.tsx (React) into dist/bundle.js, injects the precache manifest into a hand-written service worker, and copies the PWA manifest + icons from frontend/public/ into dist/.
 *
 * Usage: pnpm build:frontend
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild, defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.join(__dirname, "frontend");
const DIST_DIR = path.join(__dirname, "dist");

/**
 * Builds the mesh SharedWorker as a separate, non-hashed bundle and writes it directly into the main build's outDir on Rollup's writeBundle hook -- after Vite's own emptyOutDir and after the main chunk is written to disk, but before vite-plugin-pwa's closeBundle hook globs the outDir for its precache manifest, so mesh-worker.js is present when the PWA plugin scans for files to precache. mesh-client.ts creates this SharedWorker from a runtime string literal ("./mesh-worker.js"), invisible to Rollup's module graph, which is why it must stay a fixed-filename artifact built outside the main bundle rather than an ordinary import.
 */
function meshWorkerPlugin(): Plugin {
  return {
    name: "agent-comms-mesh-worker",
    async writeBundle() {
      await viteBuild({
        configFile: false,
        logLevel: "warn",
        build: {
          outDir: DIST_DIR,
          emptyOutDir: false,
          minify: true,
          lib: {
            entry: path.join(FRONTEND_DIR, "mesh-worker.ts"),
            formats: ["iife"],
            name: "AgentCommsMeshWorker",
            fileName: () => "mesh-worker.js",
          },
        },
      });
    },
  };
}

export default defineConfig({
  root: FRONTEND_DIR,
  plugins: [
    react(),
    meshWorkerPlugin(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: ".",
      filename: "sw.ts",
      injectRegister: false,
      manifest: false,
    }),
  ],
  build: {
    outDir: DIST_DIR,
    emptyOutDir: true,
    rollupOptions: {
      // No dynamic import() anywhere in this codebase (banned outright by eslint.config.ts's no-restricted-syntax rule) and exactly one HTML entry point, so Rollup/Rolldown can never produce more than the one chunk named here -- no code-splitting option is needed to force it.
      output: {
        entryFileNames: "bundle.js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
