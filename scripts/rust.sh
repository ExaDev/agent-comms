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
