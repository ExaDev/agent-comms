/**
 * The one display convention for anything identified by a device-id (agent-comms#345): your own petname for it first, then the name it asserts for itself, then a short id. Every surface that shows an agent, a machine, a principal or a trusted device formats it here, so the CLI, the tool output and the dashboard read the same; wire-mesh's web console follows the same order (ExaDev/wire-mesh#295).
 *
 * A petname is yours: set locally, never gossiped, so it needs no trust decision and has no collision problem. A self-asserted name is whatever the subject's own key signed (an agent's registered name, a machine's name claim), so it is shown quoted, as the subject's claim rather than a fact. The short id is the stable reference when neither name exists, and the fallback that tells two same-named subjects apart. It is a prefix of the full id, never a replacement for it: every tool action takes the full id, so a surface whose entries are acted on also prints the full id.
 *
 * Pure and dependency-free, so the browser bundle imports it as it is.
 */

/** How many leading hex characters of a device-id the short id keeps: 48 bits, enough that two devices a person deals with never share one by chance, and short enough to read and compare at a glance. */
export const SHORT_ID_LENGTH = 12;

/** Everything a display name is built from. Both names are optional; the id never is. */
export interface DisplayNameParts {
  /** The full device-id (hex). */
  id: string;
  /** The viewer's own label for this id, if they set one. */
  petname?: string | undefined;
  /** The name the subject asserts for itself, if it has one. */
  selfName?: string | undefined;
}

/** The leading SHORT_ID_LENGTH characters of id. */
export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

/** parts in display order: the petname, then the self-asserted name quoted (left out when it only repeats the petname), then the short id, separated by single spaces. */
export function formatDisplayName(parts: Readonly<DisplayNameParts>): string {
  const labels: string[] = [];
  if (parts.petname !== undefined) labels.push(parts.petname);
  if (parts.selfName !== undefined && parts.selfName !== parts.petname) {
    labels.push(`"${parts.selfName}"`);
  }
  labels.push(shortId(parts.id));
  return labels.join(" ");
}

/** The longest display name, petname or self-asserted, that is accepted: room for a descriptive label ("Joe's work laptop, office"), short enough that one never swamps a listing row. */
export const MAX_DISPLAY_NAME_LENGTH = 64;

/** The last C0 control character; everything at or below it, DEL, and the C1 range are refused, since a name is printed straight into terminals and a control sequence in one could rewrite what the viewer sees. */
const LAST_C0_CONTROL = 0x1f;
const DEL = 0x7f;
const LAST_C1_CONTROL = 0x9f;

function isControlCharacter(code: number): boolean {
  return code <= LAST_C0_CONTROL || (code >= DEL && code <= LAST_C1_CONTROL);
}

/** raw trimmed, when it is usable as a display name: not empty, at most MAX_DISPLAY_NAME_LENGTH characters, and free of control characters. Undefined otherwise. Applied to a petname as it is set and to a self-asserted name as it is received, so neither can carry anything a terminal would interpret. */
export function parseDisplayName(raw: string): string | undefined {
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_DISPLAY_NAME_LENGTH) {
    return undefined;
  }
  for (const char of name) {
    const code = char.codePointAt(0);
    if (code !== undefined && isControlCharacter(code)) return undefined;
  }
  return name;
}
