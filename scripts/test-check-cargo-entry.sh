#!/bin/sh
# Tests scripts/check-cargo-entry.sh against files written here: what it must flag and what it must leave alone.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

expect() {
  # expect <name> <flagged|clean> <file content>
  printf '%s\n' "$3" > "$work/file"
  if sh "$here/check-cargo-entry.sh" "$work/file" >/dev/null 2>&1; then actual=clean; else actual=flagged; fi
  if [ "$actual" = "$2" ]; then echo "ok   $1"; else echo "FAIL $1: expected $2, got $actual"; failures=$((failures + 1)); fi
}

expect "a shell command" flagged "cargo test --locked"
expect "a command on the second line of a script" flagged "echo hi
cargo test --locked"
expect "a command after a separator" flagged "make && cargo build"
expect "a command in a pipeline" flagged "cargo tree | sort"
expect "a workflow run line" flagged "        run: cargo deny check"
expect "a command after exec" flagged "exec cargo test"
expect "a toolchain argument" flagged "cargo +nightly fmt"
expect "a python list with a variable element" flagged 'subprocess.run(["cargo", "deny", str(path)])'
expect "a python list with single quotes" flagged "subprocess.run(['cargo', 'tree'])"
expect "the entry point called through sh" clean "sh scripts/rust.sh test"
expect "a presence test" clean "command -v cargo >/dev/null"
expect "a hyphenated tool name" clean "tool: cargo-deny@0.20.2"
expect "a job name" clean "name: cargo-deny"
expect "prose about the tool" clean "# the rust checks"
exit "$failures"
