#!/bin/sh
# Fails when a check script has no test, or a test is not run by the CI workflow that runs on every pull request. A check that is never tested can break unnoticed, and a test that never runs proves nothing.
#
# A script named check-<name>.<ext> needs a test named test-check-<name>.sh or test_check_<name>.py beside it, and every test script must be named in .github/workflows/ci.yml or run by scripts/rust-checks.sh, which that workflow runs. Usage: check-scripts-tested.sh [scripts-directory [workflow-file]].
set -eu

cd "$(dirname "$0")/.."
scripts=${1:-scripts}
workflow=${2:-.github/workflows/ci.yml}
status=0

for check in "$scripts"/check-*; do
  [ -f "$check" ] || continue
  name=$(basename "$check")
  name=${name#check-}
  name=${name%.*}
  underscored=$(printf '%s' "$name" | tr '-' '_')
  if [ ! -f "$scripts/test-check-$name.sh" ] && [ ! -f "$scripts/test_check_$underscored.py" ]; then
    echo "$check has no test (test-check-$name.sh or test_check_$underscored.py)" >&2
    status=1
  fi
done

for test in "$scripts"/test-*.sh "$scripts"/test_*.py; do
  [ -f "$test" ] || continue
  name=$(basename "$test")
  if ! grep -qF "$name" "$workflow" "$scripts/rust-checks.sh" 2>/dev/null; then
    echo "$test is not run by $workflow or $scripts/rust-checks.sh" >&2
    status=1
  fi
done
exit "$status"
