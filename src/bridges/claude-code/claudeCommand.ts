/**
 * The `ps -o comm=` forms a Claude Code CLI process takes: a binary named `claude` (a package manager's launcher, the Homebrew cask), or the native installer's versioned binary, `<root>/claude/versions/<dotted version>`, whose basename is the version and not `claude`. `hooks/drain.sh` walks the same process tree with the shell patterns in `CLAUDE_COMM_SHELL_PATTERNS`, so the bridge and the hook always key the same pending file.
 */
const CLAUDE_COMM = /(^|\/)claude$|\/claude\/versions\/\d+(\.\d+)*$/;

/** The same set as `CLAUDE_COMM`, as the `case` patterns `hooks/drain.sh` uses; a test holds the two in step. */
export const CLAUDE_COMM_SHELL_PATTERNS =
  "*/claude|claude|*/claude/versions/[0-9]*";

/** True when `comm` (as `ps -o comm=` prints it) is a Claude Code CLI process. */
export function isClaudeCodeComm(comm: string): boolean {
  return CLAUDE_COMM.test(comm);
}
