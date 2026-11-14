#!/bin/sh
# The Rust half of the pre-push hook. Reads git's pre-push lines on stdin (`<local ref> <local sha> <remote ref> <remote sha>`) and runs scripts/rust-checks.sh only when the pushed commits touch something the Rust checks cover (scripts/rust-paths.sh), so a push costs work proportional to what changed. A deleted ref pushes nothing and is skipped. When the checks are due and cargo is missing the push fails with the install instruction, never skips: a Rust change must not reach CI unchecked.
#
# RUST_CHECKS_SCRIPT replaces the checks script and DEFAULT_BRANCH_REF the ref a new branch is compared with; both exist so scripts/test-pre-push-rust.sh can exercise the range logic.
set -eu

cd "$(dirname "$0")/.."

zero=0000000000000000000000000000000000000000
base_ref=${DEFAULT_BRANCH_REF:-refs/remotes/origin/main}
checks=${RUST_CHECKS_SCRIPT:-scripts/rust-checks.sh}

changed=""
while read -r _ local_sha _ remote_sha; do
  [ "$local_sha" = "$zero" ] && continue
  if [ "$remote_sha" = "$zero" ]; then
    # A new branch: what it adds on top of the default branch. Without that ref, everything is in range.
    if base=$(git merge-base "$base_ref" "$local_sha" 2>/dev/null); then
      range="$base..$local_sha"
    else
      changed="rust/"
      continue
    fi
  elif git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
    range="$remote_sha..$local_sha"
  else
    # The remote tip is not here (a force push over unknown history): every file counts.
    changed="rust/"
    continue
  fi
  changed="$changed
$(git diff --name-only "$range")"
done

if printf '%s\n' "$changed" | sh scripts/rust-paths.sh; then
  if ! command -v cargo >/dev/null 2>&1 || ! command -v rustup >/dev/null 2>&1; then
    echo "This push changes Rust or the corpus the Rust checks read, and the Rust toolchain is not installed." >&2
    echo "Install rustup (https://rustup.rs); scripts/rust.sh installs the toolchain rust/rust-toolchain.toml pins on first use." >&2
    exit 1
  fi
  if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
    echo "This push changes Rust or the corpus the Rust checks read, and they need Python 3.9 or later (python3 was not found or is older)." >&2
    echo "Install Python 3.9 or later (.tool-versions names the version CI uses, and mise or asdf install it); the README's section on the Rust workspace lists what the hook needs." >&2
    exit 1
  fi
  exec sh "$checks"
fi
