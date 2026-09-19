/**
 * Integration tests for the opt-in web-console mount on the real HTTP server — confirms AGENT_COMMS_WEB_CONSOLE_DIST actually gates the route end to end, not just the unit-tested helper in isolation.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import http from "node:http";
import net from "node:net";
import { createWebServer, type WebServerHandle } from "../server.js";
import { WEB_CONSOLE_MOUNT } from "../web-console-static.js";
import { unreachableHubUrl } from "../../../../test/hub-helpers.js";

const ENV_VAR = "AGENT_COMMS_WEB_CONSOLE_DIST";
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function fetchText(
  port: number,
  reqPath: string,
): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers["content-type"] ?? "",
            body: data,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let handle: WebServerHandle | undefined;
let tmpDir: string | undefined;
let originalEnv: string | undefined;

/** Starts a web server and resolves once it's actually listening, returning its port. */
async function startAndGetPort(coordinatorPort: number): Promise<number> {
  const hubUrl = await unreachableHubUrl();
  const started = await createWebServer(0, undefined, coordinatorPort, hubUrl);
  handle = started;
  await new Promise<void>((resolve) => {
    if (started.server.listening) {
      resolve();
      return;
    }
    started.server.once("listening", () => resolve());
  });
  const addr = started.server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

afterEach(async () => {
  if (handle) {
    // wss.close()/server.close() are asynchronous -- neither actually releases its port until its optional callback fires. Awaiting that here keeps a later test's findFreePort() from being handed a port this handle hasn't genuinely released yet.
    await new Promise<void>((resolve) => {
      handle?.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      handle?.server.close(() => resolve());
    });
    await handle.controller.shutdown();
    handle = undefined;
  }
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

describe("web-console route (opt-in)", () => {
  it("404s under the mount when AGENT_COMMS_WEB_CONSOLE_DIST is unset", async () => {
    originalEnv = process.env[ENV_VAR];
    Reflect.deleteProperty(process.env, ENV_VAR);
    const coordinatorPort = await findFreePort();
    const port = await startAndGetPort(coordinatorPort);

    const { status } = await fetchText(port, WEB_CONSOLE_MOUNT);
    expect(status).toBe(HTTP_NOT_FOUND);
  });

  it("serves web-console's index.html and assets when the dist dir is configured", async () => {
    originalEnv = process.env[ENV_VAR];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-console-dist-"));
    fs.writeFileSync(
      path.join(tmpDir, "index.html"),
      "<!doctype html><title>web-console</title>",
    );
    fs.mkdirSync(path.join(tmpDir, "assets"));
    fs.writeFileSync(
      path.join(tmpDir, "assets", "index-abc123.js"),
      "console.log('web-console');",
    );
    process.env[ENV_VAR] = tmpDir;

    const coordinatorPort = await findFreePort();
    const port = await startAndGetPort(coordinatorPort);

    const index = await fetchText(port, WEB_CONSOLE_MOUNT);
    expect(index.status).toBe(HTTP_OK);
    expect(index.contentType).toContain("text/html");
    expect(index.body).toContain("web-console");

    const asset = await fetchText(
      port,
      `${WEB_CONSOLE_MOUNT}/assets/index-abc123.js`,
    );
    expect(asset.status).toBe(HTTP_OK);
    expect(asset.contentType).toContain("javascript");
    expect(asset.body).toContain("web-console");

    // The bridge's own frontend at "/" is unaffected by the mount.
    const own = await fetchText(port, "/");
    expect(own.status).toBe(HTTP_OK);
    expect(own.body).toContain("Agent Comms");
  });
});
