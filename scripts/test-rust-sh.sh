#!/bin/sh
# Tests that every cargo command in scripts/rust.sh except rustfmt carries --locked, so a check never resolves dependencies afresh, and that this test fails when the flag is removed from any one of them. rustfmt reads no lock file and takes no such flag.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

# The cargo command lines of a script that are not comments, not rustfmt and lack --locked.
unlocked() {
  grep -nE '^[^#]*[[:space:](]cargo[[:space:]]+[a-z]' "$1" | grep -v 'cargo fmt' | grep -v -- '--locked' || true
}

commands=$(grep -cE '^[^#]*[[:space:](]cargo[[:space:]]+[a-z]' "$here/rust.sh")
if [ "$commands" -lt 2 ]; then echo "FAIL found $commands cargo commands in rust.sh, the pattern is wrong"; failures=$((failures + 1)); fi

if [ -n "$(unlocked "$here/rust.sh")" ]; then
  echo "FAIL a cargo command in rust.sh lacks --locked:"; unlocked "$here/rust.sh"; failures=$((failures + 1))
else
  echo "ok   every cargo command in rust.sh except fmt carries --locked"
fi

# Remove --locked from each locked line in turn: the check must notice every time.
for number in $(grep -nE '^[^#]*[[:space:](]cargo[[:space:]]+[a-z].*--locked' "$here/rust.sh" | cut -d: -f1); do
  sed "${number}s/ --locked//" "$here/rust.sh" > "$work/mutant.sh"
  if [ -n "$(unlocked "$work/mutant.sh")" ]; then echo "ok   removing --locked from line $number is noticed"; else echo "FAIL removing --locked from line $number goes unnoticed"; failures=$((failures + 1)); fi
done
exit "$failures"
