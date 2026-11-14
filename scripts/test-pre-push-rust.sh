#!/bin/sh
# Tests the range logic of scripts/pre-push-rust.sh in a throwaway repository: a docs-only push, a Rust push, a corpus push, a new branch, a deletion, a forced push over history that is not here, and cargo missing.
set -eu

# git exports GIT_DIR, GIT_INDEX_FILE and the like to a hook, and they would point the throwaway repository's commands at the repository being pushed, so the test starts from a clean git environment.
for variable in $(git rev-parse --local-env-vars); do
  unset "$variable"
done

here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

check() {
  # check <name> <expected: run|skip|fail> <stdin lines> <PATH override or empty>
  name=$1 expected=$2 input=$3 path=${4:-}
  out=$(cd "$work/repo" && printf '%s\n' "$input" | env PATH="${path:-$PATH}" DEFAULT_BRANCH_REF=refs/heads/main RUST_CHECKS_SCRIPT="$work/checks.sh" sh "$work/repo/scripts/pre-push-rust.sh" 2>&1) && status=0 || status=$?
  case "$expected" in
    run) [ "$status" -eq 0 ] && [ "$out" = "checks ran" ] ;;
    skip) [ "$status" -eq 0 ] && [ -z "$out" ] ;;
    fail) [ "$status" -ne 0 ] && printf '%s' "$out" | grep -q "Install" ;;
    failpython) [ "$status" -ne 0 ] && printf '%s' "$out" | grep -q "Python 3.9" ;;
  esac && echo "ok   $name" || { echo "FAIL $name (status $status): $out"; failures=$((failures + 1)); }
}

mkdir -p "$work/repo/scripts" "$work/repo/rust" "$work/repo/docs"
cp "$here/scripts/pre-push-rust.sh" "$here/scripts/rust-paths.sh" "$work/repo/scripts/"
printf '#!/bin/sh\necho "checks ran"\n' > "$work/checks.sh"
cd "$work/repo"
git init -q -b main
git config user.email test@example.com
git config user.name test
echo a > docs/a.md && echo a > rust/a.rs
git add -A && git commit -q -m base
base=$(git rev-parse HEAD)
git checkout -q -b docs-only && echo b >> docs/a.md && git commit -qam docs
docs=$(git rev-parse HEAD)
git checkout -q -b rust-change "$base" && echo b >> rust/a.rs && git commit -qam rust
rust=$(git rev-parse HEAD)
git checkout -q -b corpus-change "$base" && mkdir -p conformance && echo b > conformance/manifest.json && git add -A && git commit -qm corpus
corpus=$(git rev-parse HEAD)
git checkout -q -b scripts-change "$base" && echo b > scripts/rust-checks.sh && git add -A && git commit -qm script
script=$(git rev-parse HEAD)
zero=0000000000000000000000000000000000000000
no_cargo=$(mktemp -d); for tool in git grep sh cat dirname mktemp env printf rm; do ln -s "$(command -v "$tool")" "$no_cargo/$tool"; done
no_python=$(mktemp -d); for tool in git grep sh cat dirname mktemp env printf rm; do ln -s "$(command -v "$tool")" "$no_python/$tool"; done
for tool in cargo rustup; do printf '#!/bin/sh\n' > "$no_python/$tool"; chmod +x "$no_python/$tool"; done
old_python=$(mktemp -d); for tool in git grep sh cat dirname mktemp env printf rm; do ln -s "$(command -v "$tool")" "$old_python/$tool"; done
for tool in cargo rustup; do printf '#!/bin/sh\n' > "$old_python/$tool"; chmod +x "$old_python/$tool"; done
printf '#!/bin/sh\nexit 1\n' > "$old_python/python3"; chmod +x "$old_python/python3"

check "docs-only push skips" skip "refs/heads/docs-only $docs refs/heads/docs-only $base"
check "rust push runs" run "refs/heads/rust-change $rust refs/heads/rust-change $base"
check "corpus push runs" run "refs/heads/corpus-change $corpus refs/heads/corpus-change $base"
check "rust script push runs" run "refs/heads/scripts-change $script refs/heads/scripts-change $base"
check "new docs-only branch skips" skip "refs/heads/docs-only $docs refs/heads/docs-only $zero"
check "new rust branch runs" run "refs/heads/rust-change $rust refs/heads/rust-change $zero"
check "deleting a branch skips" skip "(delete) $zero refs/heads/rust-change $rust"
check "forced push over unknown history runs" run "refs/heads/docs-only $docs refs/heads/docs-only 1111111111111111111111111111111111111111"
check "one docs and one rust ref runs" run "refs/heads/docs-only $docs refs/heads/docs-only $base
refs/heads/rust-change $rust refs/heads/rust-change $base"
check "rust push without a Rust toolchain fails with the instruction" fail "refs/heads/rust-change $rust refs/heads/rust-change $base" "$no_cargo"
check "rust push without python fails with the instruction" failpython "refs/heads/rust-change $rust refs/heads/rust-change $base" "$no_python"
check "rust push with a python that is too old fails with the instruction" failpython "refs/heads/rust-change $rust refs/heads/rust-change $base" "$old_python"
check "docs-only push without a Rust toolchain skips" skip "refs/heads/docs-only $docs refs/heads/docs-only $base" "$no_cargo"
rm -rf "$no_cargo" "$no_python" "$old_python"
exit "$failures"
