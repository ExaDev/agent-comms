import type { Text } from "./corpus-types.js";

/**
 * The corpus carries every string as a sequence of UTF-16 code units, either as a JSON string or as `{ "codeUnits": [...] }` (`conformance/README.md`). A JavaScript string is already that sequence, so decoding is the identity for the first form and `String.fromCharCode` for the second.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodeUnitsObject(
  value: Record<string, unknown>,
): value is { codeUnits: number[] } {
  const units = value.codeUnits;

  return Array.isArray(units) && units.every((u) => typeof u === "number");
}

/** The string a corpus text denotes. */
export function textToString(text: Text): string {
  return typeof text === "string"
    ? text
    : String.fromCharCode(...text.codeUnits);
}

/** The UTF-16 code units a corpus text denotes. */
export function textToCodeUnits(text: Text): readonly number[] {
  if (typeof text !== "string") {
    return text.codeUnits;
  }

  return Array.from({ length: text.length }, (_, index) =>
    text.charCodeAt(index),
  );
}

/** A value with every `{ "codeUnits": [...] }` replaced by the string it denotes, at any depth. The schema has already refused an object that holds a codeUnits key and anything else. */
export function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => decodeValue(item));
  }
  if (isRecord(value)) {
    if (isCodeUnitsObject(value)) {
      return String.fromCharCode(...value.codeUnits);
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decodeValue(item)]),
    );
  }

  return value;
}
