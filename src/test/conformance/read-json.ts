import { readFileSync } from "node:fs";

/** Strict: a file that is not valid UTF-8 is an error, never read with replacement characters, so every loader sees the same text (the Rust loader refuses such a file too). */
const decoder = new TextDecoder("utf-8", { fatal: true });

export function readJson(path: string): unknown {
  return JSON.parse(decoder.decode(readFileSync(path)));
}
