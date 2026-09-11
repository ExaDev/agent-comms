import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dmRoomPath,
  ownerNamedRoomPath,
  parseRoomPath,
  slugRoomName,
} from "../core/room-path.js";

const OWNER = "1".repeat(64);
const OTHER = "2".repeat(64);

test("ownerNamedRoomPath joins the owner and local name with a slash", () => {
  assert.equal(ownerNamedRoomPath(OWNER, "general"), `${OWNER}/general`);
});

test("ownerNamedRoomPath rejects an owner that isn't 64-character lowercase hex", () => {
  assert.throws(() => ownerNamedRoomPath("not-hex", "general"));
});

test("ownerNamedRoomPath rejects a local name outside [A-Za-z0-9_-]+", () => {
  assert.throws(() => ownerNamedRoomPath(OWNER, "has spaces"));
  assert.throws(() => ownerNamedRoomPath(OWNER, "has.dots"));
});

test("dmRoomPath joins the bytewise-ascending sorted pair with a plus", () => {
  assert.equal(dmRoomPath(OWNER, OTHER), `${OWNER}+${OTHER}`);
  assert.equal(dmRoomPath(OTHER, OWNER), `${OWNER}+${OTHER}`);
});

test("dmRoomPath refuses to name the same device twice", () => {
  assert.throws(() => dmRoomPath(OWNER, OWNER));
});

test("dmRoomPath rejects a participant that isn't 64-character lowercase hex", () => {
  assert.throws(() => dmRoomPath("not-hex", OTHER));
});

test("parseRoomPath recognises an owner-named path", () => {
  const parsed = parseRoomPath(`${OWNER}/general`);
  assert.deepEqual(parsed, {
    kind: "owner-named",
    owner: OWNER,
    localName: "general",
  });
});

test("parseRoomPath recognises a DM path", () => {
  const parsed = parseRoomPath(`${OWNER}+${OTHER}`);
  assert.deepEqual(parsed, {
    kind: "dm",
    participants: [OWNER, OTHER],
  });
});

test("parseRoomPath rejects a path shaped like neither", () => {
  assert.throws(() => parseRoomPath("just-a-name"));
});

test("slugRoomName replaces every character outside [A-Za-z0-9_-] with a hyphen", () => {
  assert.equal(slugRoomName("documents.js"), "documents-js");
  assert.equal(slugRoomName("my project"), "my-project");
});

test("slugRoomName leaves an already-valid name unchanged", () => {
  assert.equal(slugRoomName("agent-comms_2"), "agent-comms_2");
});

test("slugRoomName rejects a name with nothing left to slug", () => {
  assert.throws(() => slugRoomName("..."));
});
