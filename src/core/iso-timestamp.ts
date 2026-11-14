/**
 * Timestamps that arrive as text and decide whether something has expired. A text that does not parse must never read as "not yet expired", which is what comparing a failed parse (NaN) against the clock does, so every expiry in text form goes through this one parser and a caller treats `undefined` as invalid.
 */

/** The shape every timestamp this package writes has (`Date.prototype.toISOString`), and the offset form of ISO 8601 and RFC 3339 beside it: a date, `T`, a time with an optional fraction, then `Z` or a numeric offset. Anything looser (a bare year, a month name, a locale string) is parsed differently by different engines, so it is refused rather than guessed at. */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The instant `text` names, in milliseconds since the epoch, or undefined when `text` is not an ISO 8601 timestamp in the form above or names no real instant (a month 13, say).
 */
export function parseIsoTimestampMs(text: string): number | undefined {
  if (!ISO_TIMESTAMP.test(text)) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Whether `text` is a timestamp parseIsoTimestampMs accepts. */
export function isIsoTimestamp(text: string): boolean {
  return parseIsoTimestampMs(text) !== undefined;
}
