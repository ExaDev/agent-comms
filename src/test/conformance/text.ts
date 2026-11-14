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

/** The numbers a corpus file names with `{ "$number": name }`, a closed lookup: the canonical JSON form writes a negative zero as 0 and has no infinity or NaN. */
const NAMED_NUMBERS: Readonly<Record<string, number>> = {
  "-0": -0,
  Infinity: Number.POSITIVE_INFINITY,
  "-Infinity": Number.NEGATIVE_INFINITY,
  NaN: Number.NaN,
};

/** The name of a special number, as a corpus file writes it, or undefined for any other number. */
export function specialNumberName(value: number): string | undefined {
  if (Number.isNaN(value)) return "NaN";
  if (Object.is(value, -0)) return "-0";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";

  return undefined;
}

/** A value with every `{ "codeUnits": [...] }` replaced by the string it denotes and every `{ "$number": name }` by the number it names, at any depth. The schema has already refused an object that holds either key and anything else. */
export function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => decodeValue(item));
  }
  if (isRecord(value)) {
    const named = value.$number;
    if (typeof named === "string" && Object.keys(value).length === 1) {
      const decoded = NAMED_NUMBERS[named];
      if (decoded === undefined) {
        throw new Error(`$number names ${named}, which no corpus file may`);
      }

      return decoded;
    }
    if (isCodeUnitsObject(value)) {
      return String.fromCharCode(...value.codeUnits);
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decodeValue(item)]),
    );
  }

  return value;
}
