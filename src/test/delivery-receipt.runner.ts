#!/usr/bin/env node
/**
 * Delivery receipt test runner — runs each test case in an isolated child
 * process. Tests MUST NOT be run from within a process that has the
 * agent-comms extension loaded (e.g. pi's agent session), because the
 * parent's active TCP handles interfere with child process forking.
 *
 * Usage:
 *   pnpm test:delivery           # from a clean shell (recommended)
 *   node dist/test/delivery-receipt.runner.js
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const HELPER = path.join(__dirname, "delivery-receipt.helper.js");

const tests = [
  "push-room",
  "push-dm",
  "drain-room",
  "drain-dm",
  "read-receipt-push",
  "read-receipt-drain",
  "readby-array",
];

let failed = false;

for (const t of tests) {
  try {
    const stdout = execFileSync(process.execPath, [HELPER, t], {
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (stdout.trim()) console.log(stdout.trim());
    console.log(`${t} ✓`);
  } catch (e: unknown) {
    const msg =
      e instanceof Error && "stderr" in e && typeof e.stderr === "string"
        ? e.stderr.trim() || e.message
        : String(e);
    console.error(`${t} ✗ ${msg}`);
    failed = true;
    break;
  }
}

if (!failed) {
  console.log("\nAll 7 delivery receipt tests passed!");
}

process.exit(failed ? 1 : 0);
