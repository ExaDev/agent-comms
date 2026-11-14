/**
 * The pairing secret store and what the bridge and the dashboard agree on: how the secret is made and kept, read after a rotation, presented, and handed over.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDirectory } from "../../../../test/scratch-directory.helper.js";
import {
  MESH_SUBPROTOCOL,
  PAIRING_HEADER,
  PAIRING_SECRET_PATTERN,
  PAIRING_SUBPROTOCOL_PREFIX,
  meshSocketProtocols,
} from "../pairing-protocol.js";
import { HOSTED_DASHBOARD_ORIGIN } from "../web-access.js";
import {
  HOSTED_DASHBOARD_URL,
  PAIRING_PAGE_HEADERS,
  dashboardPairingUrl,
  openPairingSecret,
  pairingPageHtml,
  pairingSecretFile,
  presentedPairingSecret,
  rotatePairingSecret,
  selectMeshSubprotocol,
} from "../web-pairing.js";

const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;
const PERMISSION_MASK = 0o777;
const SECRET_HEX_LENGTH = 64;
const SHORT_SECRET_BYTES = 8;
const SECRET = "a".repeat(SECRET_HEX_LENGTH);
const OTHER_SECRET = "b".repeat(SECRET_HEX_LENGTH);

function freshDir(): string {
  return path.join(scratchDirectory("agent-comms-pairing-"), "state");
}

describe("the secret store", () => {
  it("creates a 256-bit hex secret in an owner-only file in an owner-only directory", () => {
    const dir = freshDir();

    const secret = openPairingSecret({ dir }).current();

    expect(secret).toMatch(PAIRING_SECRET_PATTERN);
    const file = pairingSecretFile(dir);
    expect(fs.statSync(file).mode & PERMISSION_MASK).toBe(OWNER_ONLY_FILE);
    expect(fs.statSync(dir).mode & PERMISSION_MASK).toBe(OWNER_ONLY_DIR);
    expect(fs.readFileSync(file, "utf-8").trim()).toBe(secret);
  });

  it("keeps the secret between opens and never makes two the same", () => {
    const first = openPairingSecret({ dir: freshDir() }).current();
    const second = openPairingSecret({ dir: freshDir() }).current();
    const dir = freshDir();

    expect(first).not.toBe(second);
    expect(openPairingSecret({ dir }).current()).toBe(
      openPairingSecret({ dir }).current(),
    );
  });

  it("reads a rotation made by another process without being restarted", () => {
    const dir = freshDir();
    const store = openPairingSecret({ dir });
    const before = store.current();

    rotatePairingSecret(dir);

    expect(store.current()).not.toBe(before);
    expect(store.current()).toMatch(PAIRING_SECRET_PATTERN);
  });

  it.each([
    ["an empty file", ""],
    ["text that is not a secret", "not a secret"],
    ["a secret of the wrong length", "ab".repeat(SHORT_SECRET_BYTES)],
    ["a secret in upper case", "A".repeat(SECRET_HEX_LENGTH)],
  ])("replaces %s with a fresh secret and says so", (_name, content) => {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pairingSecretFile(dir), content);
    const replaced = vi.fn<(file: string) => void>();

    const secret = openPairingSecret({ dir, onReplaced: replaced }).current();

    expect(secret).toMatch(PAIRING_SECRET_PATTERN);
    expect(replaced).toHaveBeenCalledWith(pairingSecretFile(dir));
  });

  it("does not report a file it created itself as replaced", () => {
    const replaced = vi.fn<(file: string) => void>();

    openPairingSecret({ dir: freshDir(), onReplaced: replaced }).current();

    expect(replaced).not.toHaveBeenCalled();
  });
});

describe("what a request presents", () => {
  it("reads the header", () => {
    expect(presentedPairingSecret({ [PAIRING_HEADER]: SECRET })).toBe(SECRET);
  });

  it("reads the secret from an offered subprotocol among others", () => {
    const offered = meshSocketProtocols(SECRET).join(", ");

    expect(presentedPairingSecret({ "sec-websocket-protocol": offered })).toBe(
      SECRET,
    );
  });

  it("presents nothing when neither is offered", () => {
    expect(presentedPairingSecret({})).toBeUndefined();
    expect(
      presentedPairingSecret({ "sec-websocket-protocol": MESH_SUBPROTOCOL }),
    ).toBeUndefined();
  });

  it("selects only the fixed subprotocol, never the one carrying the secret", () => {
    const offered = new Set(meshSocketProtocols(SECRET));

    expect(selectMeshSubprotocol(offered)).toBe(MESH_SUBPROTOCOL);
    expect(
      selectMeshSubprotocol(
        new Set([`${PAIRING_SUBPROTOCOL_PREFIX}${SECRET}`]),
      ),
    ).toBe(false);
    expect(selectMeshSubprotocol(new Set())).toBe(false);
  });
});

describe("handing the secret over", () => {
  it("opens the dashboard at its exact origin and path, with the secret only in the fragment", () => {
    const url = new URL(dashboardPairingUrl(SECRET));

    expect(url.origin).toBe(HOSTED_DASHBOARD_ORIGIN);
    expect(`${url.origin}${url.pathname}`).toBe(HOSTED_DASHBOARD_URL);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#pair=${SECRET}`);
  });

  it("puts the secret on the page only inside the link that opens the dashboard", () => {
    const html = pairingPageHtml(OTHER_SECRET);

    expect(html.split(OTHER_SECRET)).toHaveLength(2);
    expect(html).toContain(`href="${dashboardPairingUrl(OTHER_SECRET)}"`);
    expect(html).not.toContain("<script");
  });

  it("is sent so that it cannot be framed, cached or passed on as a referrer", () => {
    expect(PAIRING_PAGE_HEADERS["X-Frame-Options"]).toBe("DENY");
    expect(PAIRING_PAGE_HEADERS["Cache-Control"]).toBe("no-store");
    expect(PAIRING_PAGE_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    expect(PAIRING_PAGE_HEADERS["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });
});
