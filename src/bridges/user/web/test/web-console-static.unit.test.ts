/**
 * Unit tests for web-console static-file resolution and serving.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type http from "node:http";
import {
  resolveWebConsoleDist,
  serveWebConsole,
  WEB_CONSOLE_MOUNT,
} from "../web-console-static.js";

const ENV_VAR = "AGENT_COMMS_WEB_CONSOLE_DIST";
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

let tmpDir: string | undefined;
let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env[ENV_VAR];
});

afterEach(() => {
  if (originalEnv === undefined) {
    Reflect.deleteProperty(process.env, ENV_VAR);
  } else {
    process.env[ENV_VAR] = originalEnv;
  }
  if (tmpDir !== undefined) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function makeDistDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-console-dist-"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    "<!doctype html><title>web-console</title>",
  );
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(
    path.join(dir, "assets", "index-abc123.js"),
    "console.log('web-console');",
  );
  return dir;
}

describe("resolveWebConsoleDist", () => {
  it("returns undefined when the env var is unset", () => {
    Reflect.deleteProperty(process.env, ENV_VAR);
    expect(resolveWebConsoleDist()).toBeUndefined();
  });

  it("returns undefined when the env var is set but empty", () => {
    process.env[ENV_VAR] = "";
    expect(resolveWebConsoleDist()).toBeUndefined();
  });

  it("returns undefined when the configured directory has no index.html", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-console-empty-"));
    process.env[ENV_VAR] = tmpDir;
    expect(resolveWebConsoleDist()).toBeUndefined();
  });

  it("returns undefined when the configured path doesn't exist at all", () => {
    process.env[ENV_VAR] = "/nonexistent/path/that/should/not/exist";
    expect(resolveWebConsoleDist()).toBeUndefined();
  });

  it("returns the resolved directory when it contains an index.html", () => {
    tmpDir = makeDistDir();
    process.env[ENV_VAR] = tmpDir;
    expect(resolveWebConsoleDist()).toBe(path.resolve(tmpDir));
  });
});

/** Minimal in-memory ServerResponse capture, avoiding a real socket. */
function captureResponse(): {
  res: http.ServerResponse;
  result: Promise<{ status: number; contentType: string; body: string }>;
} {
  let status = 0;
  let contentType = "";
  const chunks: Buffer[] = [];
  let resolveResult: (
    v: Readonly<{
      status: number;
      contentType: string;
      body: string;
    }>,
  ) => void;
  const result = new Promise<{
    status: number;
    contentType: string;
    body: string;
  }>((resolve) => {
    resolveResult = resolve;
  });

  const res = {
    writeHead(code: number, headers?: Record<string, string>) {
      status = code;
      contentType = headers?.["Content-Type"] ?? "";
      return res;
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      resolveResult({
        status,
        contentType,
        body: Buffer.concat(chunks).toString(),
      });
    },
  } as unknown as http.ServerResponse;

  return { res, result };
}

describe("serveWebConsole", () => {
  it("returns false for a path outside the mount", () => {
    tmpDir = makeDistDir();
    const { res } = captureResponse();
    expect(serveWebConsole(tmpDir, "/api/agents", res)).toBe(false);
  });

  it("serves index.html at the bare mount path", async () => {
    tmpDir = makeDistDir();
    const { res, result } = captureResponse();
    expect(serveWebConsole(tmpDir, WEB_CONSOLE_MOUNT, res)).toBe(true);
    const { status, contentType, body } = await result;
    expect(status).toBe(HTTP_OK);
    expect(contentType).toContain("text/html");
    expect(body).toContain("web-console");
  });

  it("serves index.html at the mount path with a trailing slash", async () => {
    tmpDir = makeDistDir();
    const { res, result } = captureResponse();
    expect(serveWebConsole(tmpDir, `${WEB_CONSOLE_MOUNT}/`, res)).toBe(true);
    const { status, body } = await result;
    expect(status).toBe(HTTP_OK);
    expect(body).toContain("web-console");
  });

  it("serves a nested asset with the correct content type", async () => {
    tmpDir = makeDistDir();
    const { res, result } = captureResponse();
    expect(
      serveWebConsole(
        tmpDir,
        `${WEB_CONSOLE_MOUNT}/assets/index-abc123.js`,
        res,
      ),
    ).toBe(true);
    const { status, contentType, body } = await result;
    expect(status).toBe(HTTP_OK);
    expect(contentType).toContain("javascript");
    expect(body).toContain("web-console");
  });

  it("returns 404 for a missing file under the mount", async () => {
    tmpDir = makeDistDir();
    const { res, result } = captureResponse();
    expect(serveWebConsole(tmpDir, `${WEB_CONSOLE_MOUNT}/nope.js`, res)).toBe(
      true,
    );
    const { status } = await result;
    expect(status).toBe(HTTP_NOT_FOUND);
  });

  it("returns 404 rather than escaping the dist directory via path traversal", async () => {
    tmpDir = makeDistDir();
    const { res, result } = captureResponse();
    expect(
      serveWebConsole(
        tmpDir,
        `${WEB_CONSOLE_MOUNT}/../../../../etc/passwd`,
        res,
      ),
    ).toBe(true);
    const { status } = await result;
    expect(status).toBe(HTTP_NOT_FOUND);
  });
});
