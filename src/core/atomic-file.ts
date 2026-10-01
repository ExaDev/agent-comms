/**
 * Whole-file writes that a concurrent reader never observes half done, shared by the per-slot identity store (identity-store.ts), the grouping-issuer identity files (issuer-identity-file.ts) and the petnames file (petnames.ts). Every bridge on the machine may read these files while another bridge is writing them, so a reader must see either the complete previous content or the complete new content, never an empty or partial file.
 */

import * as fs from "node:fs";

/** A sibling path unique to this process and call, on the same filesystem as filePath so a rename or link from it is atomic. */
function temporarySibling(filePath: string): string {
  return `${filePath}.${String(process.pid)}.${String(Math.random()).slice(2)}.tmp`;
}

/**
 * Writes content to filePath atomically: the full content is written to a temporary sibling file first, then renamed into place. rename() on the same filesystem is atomic, so a concurrent reader of filePath always sees either the complete previous content or the complete new content, never a truncated or partially-written file, unlike a bare writeFileSync, whose own open(O_TRUNC)-then-write leaves a real window where a concurrent reader can observe an empty or partial file.
 */
export function writeFileAtomic(
  filePath: string,
  content: string,
  mode: number,
): void {
  const tmpFile = temporarySibling(filePath);
  fs.writeFileSync(tmpFile, content, { encoding: "utf-8", mode });
  fs.renameSync(tmpFile, filePath);
}

/**
 * Creates filePath with content only if nothing exists there yet, atomically: the full content is written to a temporary sibling first and then hard-linked into place. link() fails with EEXIST when the name already exists and never replaces it, and the name appears only once its content is complete, unlike open with the "wx" flag followed by a write, which leaves the file empty for a moment. Returns false when another writer created filePath first, leaving that writer's file untouched.
 */
export function createFileExclusive(
  filePath: string,
  content: string,
  mode: number,
): boolean {
  const tmpFile = temporarySibling(filePath);
  fs.writeFileSync(tmpFile, content, { encoding: "utf-8", mode });
  try {
    fs.linkSync(tmpFile, filePath);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") {
      return false;
    }
    throw err;
  } finally {
    fs.unlinkSync(tmpFile);
  }
}
