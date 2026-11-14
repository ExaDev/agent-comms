import { readFileSync } from "node:fs";

/** Strict: a file that is not valid UTF-8 is an error, never read with replacement characters, and a leading byte order mark is kept and so refused by the parse, so every loader sees the same text (the Rust loader refuses both too). */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The text of a file, decoded as strictly as readJson does. */
export function readText(path: string): string {
  return decoder.decode(readFileSync(path));
}

export function readJson(path: string): unknown {
  return JSON.parse(readText(path));
}
