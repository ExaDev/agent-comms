#!/bin/sh
# The one place cargo is run from. Every other file in the repository (workflows, hooks, package scripts, other scripts) calls `sh scripts/rust.sh <check>` and never cargo itself, so there is one list of invocations to review, each against the committed lock file and the toolchain rust/rust-toolchain.toml pins, which applies because every check runs from rust/. scripts/check-cargo-entry.sh fails when anything else runs cargo directly; indirect forms such as sh -c or xargs are not detected (ExaDev/trilean issue 136).
#
# Usage: rust.sh <check> [arguments]. Checks:
#   fmt                         formatting
#   clippy                      lints, warnings denied
#   test                        the tests
#   deny                        cargo-deny's bans, licences and sources, which change only with the change under review
#   advisories                  cargo-deny's advisories, which change with the advisory database
#   deny-bans <manifest> <config>        the bans check of another workspace with its own configuration (absolute paths)
#   deny-bans-json <manifest> <config>   the same, with cargo-deny's diagnostics as JSON lines on stderr
#   metadata [manifest]         the workspace members as cargo metadata JSON on stdout
set -eu

cd "$(dirname "$0")/../rust"

# The pinned toolchain is installed on first use, since rustup does not install it by itself. Its output goes to stderr so stdout stays clean for metadata.
rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install >&2

# Every check runs on the toolchain rust-toolchain.toml pins, whatever the host has set: a rustup directory override or a RUSTUP_TOOLCHAIN in the environment outranks the file, and a cargo earlier on PATH than rustup's (a package manager's) ignores it. The channel is read from the file, exported, and the directory of that toolchain's own cargo goes first on PATH.
channel=$(sed -n 's/^channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' rust-toolchain.toml)
[ -n "$channel" ] || { echo "rust.sh: no channel in rust/rust-toolchain.toml" >&2; exit 2; }
RUSTUP_TOOLCHAIN=$channel
export RUSTUP_TOOLCHAIN
PATH="$(dirname "$(rustup which cargo)"):$PATH"
export PATH

# A check gives the same result on any host, so it takes nothing from the host's performance setup: no compiler wrapper (a cache such as sccache, set in the environment or in a cargo config, which is overridden here by empty values) and no build directory shared with other workspaces or other compiler versions, which can hold artefacts this compiler cannot read. Build output goes under rust/target, which is not tracked.
RUSTC_WRAPPER=
RUSTC_WORKSPACE_WRAPPER=
CARGO_BUILD_RUSTC_WRAPPER=
CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER=
CARGO_TARGET_DIR=$PWD/target
CARGO_BUILD_BUILD_DIR=$PWD/target
export RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER CARGO_BUILD_RUSTC_WRAPPER CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER CARGO_TARGET_DIR CARGO_BUILD_BUILD_DIR
unset CARGO_BUILD_TARGET_DIR

check=${1:-}
[ "$#" -eq 0 ] || shift
case "$check" in
  fmt) cargo fmt --check ;;
  clippy) cargo clippy --locked --all-targets --all-features -- -D warnings ;;
  test) cargo test --locked --all-targets --all-features ;;
  deny) cargo deny --locked check bans licenses sources ;;
  advisories) cargo deny --locked check advisories ;;
  deny-bans) cargo deny --locked --manifest-path "$1" --config "$2" check bans ;;
  deny-bans-json) cargo deny --locked --manifest-path "$1" --config "$2" --format json -L info check bans ;;
  metadata)
    if [ "$#" -gt 0 ]; then
      cargo metadata --locked --no-deps --format-version 1 --manifest-path "$1"
    else
      cargo metadata --locked --no-deps --format-version 1
    fi
    ;;
  *)
    echo "usage: rust.sh fmt|clippy|test|deny|advisories|deny-bans|deny-bans-json|metadata [arguments]" >&2
    exit 2
    ;;
esac
