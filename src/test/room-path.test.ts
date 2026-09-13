import { test, expect } from "vitest";
import {
  dmRoomPath,
  ownerNamedRoomPath,
  parseRoomPath,
  slugRoomName,
} from "../core/room-path.js";

const OWNER = "1".repeat(64);
const OTHER = "2".repeat(64);

test("ownerNamedRoomPath joins the owner and local name with a slash", () => {
  expect(ownerNamedRoomPath(OWNER, "general")).toBe(`${OWNER}/general`);
});

test("ownerNamedRoomPath rejects an owner that isn't 64-character lowercase hex", () => {
  expect(() => ownerNamedRoomPath("not-hex", "general")).toThrow();
});

test("ownerNamedRoomPath rejects a local name outside [A-Za-z0-9_-]+", () => {
  expect(() => ownerNamedRoomPath(OWNER, "has spaces")).toThrow();
  expect(() => ownerNamedRoomPath(OWNER, "has.dots")).toThrow();
});

test("dmRoomPath joins the bytewise-ascending sorted pair with a plus", () => {
  expect(dmRoomPath(OWNER, OTHER)).toBe(`${OWNER}+${OTHER}`);
  expect(dmRoomPath(OTHER, OWNER)).toBe(`${OWNER}+${OTHER}`);
});

test("dmRoomPath refuses to name the same device twice", () => {
  expect(() => dmRoomPath(OWNER, OWNER)).toThrow();
});

test("dmRoomPath rejects a participant that isn't 64-character lowercase hex", () => {
  expect(() => dmRoomPath("not-hex", OTHER)).toThrow();
});

test("parseRoomPath recognises an owner-named path", () => {
  const parsed = parseRoomPath(`${OWNER}/general`);
  expect(parsed).toEqual({
    kind: "owner-named",
    owner: OWNER,
    localName: "general",
  });
});

test("parseRoomPath recognises a DM path", () => {
  const parsed = parseRoomPath(`${OWNER}+${OTHER}`);
  expect(parsed).toEqual({
    kind: "dm",
    participants: [OWNER, OTHER],
  });
});

test("parseRoomPath rejects a path shaped like neither", () => {
  expect(() => parseRoomPath("just-a-name")).toThrow();
});

test("slugRoomName replaces every character outside [A-Za-z0-9_-] with a hyphen", () => {
  expect(slugRoomName("documents.js")).toBe("documents-js");
  expect(slugRoomName("my project")).toBe("my-project");
});

test("slugRoomName leaves an already-valid name unchanged", () => {
  expect(slugRoomName("agent-comms_2")).toBe("agent-comms_2");
});

test("slugRoomName rejects a name with nothing left to slug", () => {
  expect(() => slugRoomName("...")).toThrow();
});
