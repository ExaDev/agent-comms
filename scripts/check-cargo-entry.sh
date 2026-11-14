#!/bin/sh
# Fails when cargo is run directly anywhere but scripts/rust.sh. Indirect forms (sh -c, env, xargs, rustup run, a package script) are not detected: ExaDev/trilean issue 136 tracks them. A tracked file other than the entry point that holds a command word `cargo`, or a Python list that starts with "cargo", is a cargo invocation nobody reviewed against the lock file and the pinned toolchain. This is a plain search over tracked files, not a parser: prose that would match is reworded, since prose that looks like a command is a bad sentence anyway.
#
# Usage: check-cargo-entry.sh [file...]. With no file it searches every tracked file except Markdown, lock files and the files that define or test this rule.
set -eu

cd "$(dirname "$0")/.."

pattern='(^|[;&|(`]|run:|exec)[[:space:]]*cargo[[:space:]]+[+[:alpha:]-]|\[[[:space:]]*["'"'"']cargo["'"'"']'

if [ "$#" -gt 0 ]; then
  found=$(grep -nEH "$pattern" "$@" || true)
else
  found=$(git ls-files -z | grep -zEv '(\.md|\.lock|Cargo\.toml)$|^scripts/(rust\.sh|check-cargo-entry\.sh|test-check-cargo-entry\.sh)$|^conformance/fixtures/' | xargs -0 grep -nEH "$pattern" || true)
fi
if [ -n "$found" ]; then
  echo "cargo is run outside scripts/rust.sh:" >&2
  echo "$found" >&2
  exit 1
fi
