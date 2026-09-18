/**
 * Static-file serving for wire-mesh's web-console — a generic, protocol-level reference UI for any wire-mesh-compatible node, mounted alongside agent-comms' own richer dashboard as an alternate view.
 *
 * Serving is opt-in and off by default: web-console is a separate, unpublished Vite/React app (wire-mesh/ts/packages/web-console), not a dependency of this package, so there is no build output to serve unless someone has built one locally and pointed AGENT_COMMS_WEB_CONSOLE_DIST at it. When the variable is unset, empty, or doesn't resolve to a directory containing an index.html, the mount is never registered.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type * as http from "node:http";

/** Route prefix web-console's static output is served under. */
export const WEB_CONSOLE_MOUNT = "/web-console";

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/**
 * Resolves the configured web-console dist directory, if any.
 *
 * Reads AGENT_COMMS_WEB_CONSOLE_DIST and confirms it points at a directory containing an index.html. Returns undefined otherwise — the caller should then skip registering the mount entirely rather than register it and 404 on every request.
 */
export function resolveWebConsoleDist(): string | undefined {
  const configured = process.env.AGENT_COMMS_WEB_CONSOLE_DIST;
  if (configured === undefined || configured === "") return undefined;
  const dist = path.resolve(configured);
  if (!fs.existsSync(path.join(dist, "index.html"))) return undefined;
  return dist;
}

/**
 * Serves a request under the web-console mount from a resolved dist directory.
 *
 * Returns false when pathname falls outside the mount entirely, so the caller can fall through to its own routing. Returns true for every request inside the mount, including ones answered with a 404 (missing file, or a path-traversal attempt resolving outside distDir) — the caller's own response has already been written in that case too.
 */
export function serveWebConsole(
  distDir: string,
  pathname: string,
  res: http.ServerResponse,
): boolean {
  if (
    pathname !== WEB_CONSOLE_MOUNT &&
    !pathname.startsWith(`${WEB_CONSOLE_MOUNT}/`)
  ) {
    return false;
  }

  const suffix = pathname.slice(WEB_CONSOLE_MOUNT.length);
  const relative =
    suffix === "" || suffix === "/" ? "index.html" : suffix.slice(1);

  const resolvedDist = path.resolve(distDir);
  const resolvedFile = path.resolve(resolvedDist, relative);
  const withinDist =
    resolvedFile === resolvedDist ||
    resolvedFile.startsWith(`${resolvedDist}${path.sep}`);

  if (
    !withinDist ||
    !fs.existsSync(resolvedFile) ||
    !fs.statSync(resolvedFile).isFile()
  ) {
    res.writeHead(HTTP_NOT_FOUND);
    res.end("Not found");
    return true;
  }

  const contentType =
    CONTENT_TYPES[path.extname(resolvedFile)] ?? DEFAULT_CONTENT_TYPE;
  res.writeHead(HTTP_OK, { "Content-Type": contentType });
  res.end(fs.readFileSync(resolvedFile));
  return true;
}
