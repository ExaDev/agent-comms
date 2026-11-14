import { readFileSync } from "node:fs";

/** Strict: a file that is not valid UTF-8 is an error, never read with replacement characters, and a leading byte order mark is kept and so refused by the parse, so every loader sees the same text (the Rust loader refuses both too). */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function readJson(path: string): unknown {
  return JSON.parse(decoder.decode(readFileSync(path)));
}
