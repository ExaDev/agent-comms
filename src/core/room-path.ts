/**
 * Room paths — the naming and parsing convention core/room's device-keyed membership uses, mirroring wire-mesh spec/room.cddl exactly: an owner-named room is `<owner-hex>/<local-name>`, trust rooted at the owner named in the path; a DM is the bytewise-ascending sorted pair `<lower-hex>+<higher-hex>`, trust rooted at the verifier itself rather than either named party (see room.cddl's own comments for why that asymmetry is load-bearing, not incidental).
 */

const DEVICE_ID_HEX_PATTERN = /^[0-9a-f]{64}$/;
const LOCAL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const SLUG_INVALID_RUN = /[^A-Za-z0-9_-]+/g;

function assertDeviceIdHex(value: string, label: string): void {
  if (!DEVICE_ID_HEX_PATTERN.test(value)) {
    throw new Error(
      `expected ${label} to be a 64-character lowercase hex device-id, got ${JSON.stringify(value)}`,
    );
  }
}

/** `<owner-hex>/<local-name>`. localName must already satisfy [A-Za-z0-9_-]+ -- run an untrusted name through slugRoomName first. */
export function ownerNamedRoomPath(owner: string, localName: string): string {
  assertDeviceIdHex(owner, "owner");
  if (!LOCAL_NAME_PATTERN.test(localName)) {
    throw new Error(
      `expected localName to match [A-Za-z0-9_-]+, got ${JSON.stringify(localName)}`,
    );
  }
  return `${owner}/${localName}`;
}

/** `<lower-hex>+<higher-hex>`, the bytewise-ascending sorted pair. Refuses a==b outright: a path naming the same device twice is not a valid DM path at all, and self-DM is a purely local scratchpad note that needs no path (see mesh-store.ts's own sendDm). */
export function dmRoomPath(a: string, b: string): string {
  assertDeviceIdHex(a, "a");
  assertDeviceIdHex(b, "b");
  if (a === b) {
    throw new Error(`a DM room path cannot name the same device twice (${a})`);
  }
  return a < b ? `${a}+${b}` : `${b}+${a}`;
}

export type ParsedRoomPath =
  | { kind: "owner-named"; owner: string; localName: string }
  | { kind: "dm"; participants: [string, string] };

/** Parses a room-path back into its owner-named or DM shape. Throws on anything matching neither -- there is no third path shape. */
export function parseRoomPath(path: string): ParsedRoomPath {
  const slashIndex = path.indexOf("/");
  if (slashIndex !== -1) {
    const owner = path.slice(0, slashIndex);
    const localName = path.slice(slashIndex + 1);
    if (
      DEVICE_ID_HEX_PATTERN.test(owner) &&
      LOCAL_NAME_PATTERN.test(localName)
    ) {
      return { kind: "owner-named", owner, localName };
    }
  }
  const plusIndex = path.indexOf("+");
  if (plusIndex !== -1) {
    const first = path.slice(0, plusIndex);
    const second = path.slice(plusIndex + 1);
    if (
      DEVICE_ID_HEX_PATTERN.test(first) &&
      DEVICE_ID_HEX_PATTERN.test(second) &&
      first !== second
    ) {
      return { kind: "dm", participants: [first, second] };
    }
  }
  throw new Error(`${JSON.stringify(path)} is not a valid room-path`);
}

/** Sanitises an arbitrary name (e.g. a directory basename) into a valid room-path localName by replacing every run of characters outside [A-Za-z0-9_-] with a single hyphen. Throws if nothing valid remains. */
export function slugRoomName(name: string): string {
  const slug = name.replace(SLUG_INVALID_RUN, "-").replace(/^-+|-+$/g, "");
  if (slug.length === 0) {
    throw new Error(
      `${JSON.stringify(name)} has no valid room-name characters to slug`,
    );
  }
  return slug;
}
