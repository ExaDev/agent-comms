#!/bin/sh
# Tests scripts/check-scripts-tested.sh over throwaway script directories.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

expect() {
  # expect <name> <pass|fail>; the directory $work/scripts and workflow $work/ci.yml are set up by the caller
  if sh "$here/check-scripts-tested.sh" "$work/scripts" "$work/ci.yml" >/dev/null 2>&1; then actual=pass; else actual=fail; fi
  if [ "$actual" = "$2" ]; then echo "ok   $1"; else echo "FAIL $1: expected $2, got $actual"; failures=$((failures + 1)); fi
}

reset() { rm -rf "$work/scripts"; mkdir "$work/scripts"; : > "$work/ci.yml"; : > "$work/scripts/rust-checks.sh"; }

reset
expect "an empty directory passes" pass
reset; : > "$work/scripts/check-a.sh"
expect "a check without a test fails" fail
reset; : > "$work/scripts/check-a.sh"; : > "$work/scripts/test-check-a.sh"
expect "a test the workflow does not run fails" fail
reset; : > "$work/scripts/check-a.sh"; : > "$work/scripts/test-check-a.sh"; echo "run: sh scripts/test-check-a.sh" > "$work/ci.yml"
expect "a check with a test the workflow runs passes" pass
reset; : > "$work/scripts/check-a-b.py"; : > "$work/scripts/test_check_a_b.py"; echo "python3 test_check_a_b.py" > "$work/scripts/rust-checks.sh"
expect "a python check with a test run by rust-checks passes" pass
exit "$failures"
