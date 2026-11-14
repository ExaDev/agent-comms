#!/bin/sh
# The Rust checks that run both in CI's rust job and in the pre-push hook, so the two cannot drift: the guards (only scripts/rust.sh runs cargo, the workspace crates take the shared settings), the tests of those guards, formatting, clippy with warnings denied, and the tests. Every cargo invocation is in scripts/rust.sh, against the committed Cargo.lock and the pinned toolchain.
set -eu

cd "$(dirname "$0")/.."

sh scripts/check-cargo-entry.sh
sh scripts/check-scripts-tested.sh
sh scripts/test-check-cargo-entry.sh
sh scripts/test-check-scripts-tested.sh
sh scripts/test-pre-push-rust.sh
sh scripts/test-rust-sh.sh
python3 -I scripts/test_check_workspace_members.py
python3 -I scripts/test_check_tool_pins.py
python3 -I scripts/check-workspace-members.py
sh scripts/rust.sh fmt
sh scripts/rust.sh clippy
sh scripts/rust.sh test
