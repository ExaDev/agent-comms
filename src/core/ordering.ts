/**
 * Orderings that depend on neither a locale nor a runtime's collation data, so every implementation sorts the same names the same way. Strings compare by UTF-16 code unit, the order of JavaScript's `<`.
 */

/**
 * Compares two strings by UTF-16 code unit.
 * @returns A negative number when `a` sorts first, a positive one when `b` does, 0 when they are equal.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Folds the ASCII letters A to Z to lower case and leaves every other character as it is, so no Unicode case table is involved. */
function foldAsciiCase(name: string): string {
  return name.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

/**
 * Compares two names a person reads: ASCII letters are folded to lower case before comparing by UTF-16 code unit, and names that fold equal are ordered by the names as written, so the order is total and stable.
 * @returns A negative number when `a` sorts first, a positive one when `b` does, 0 when they are equal.
 */
export function compareDisplayNames(a: string, b: string): number {
  const folded = compareCodeUnits(foldAsciiCase(a), foldAsciiCase(b));
  return folded === 0 ? compareCodeUnits(a, b) : folded;
}
