"""Tests for check-deny-allowlist.py against a workspace whose one dependency exists only on another platform.

The reviewer's scenario: a dependency under `[target.'cfg(windows)'...]`. cargo-deny checks every platform, so it must be allowed there, and the allowlist check must agree with cargo-deny on that and on a surplus entry. They need the pinned toolchain and cargo-deny, and cargo downloads the fixture's one crate.
"""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
FIXTURE = SCRIPTS / "fixtures" / "platform-gated"


def cargo_deny(config: str) -> int:
    """The exit status of cargo-deny's own bans check, which is the enforcing definition."""
    return subprocess.run(
        ["sh", str(SCRIPTS / "rust.sh"), "deny-bans", str(FIXTURE / "Cargo.toml"), str(FIXTURE / config)],
        check=False,
        capture_output=True,
    ).returncode


def allowlist_check(config: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-I", str(SCRIPTS / "check-deny-allowlist.py"), "--manifest", str(FIXTURE / "Cargo.toml"), "--config", str(FIXTURE / config)],
        check=False,
        capture_output=True,
        text=True,
    )


class PlatformGatedCrate(unittest.TestCase):
    def test_both_pass_when_the_gated_crate_is_allowed(self) -> None:
        self.assertEqual(cargo_deny("deny-allowed.toml"), 0)
        result = allowlist_check("deny-allowed.toml")
        self.assertEqual((result.returncode, result.stdout), (0, ""))

    def test_both_fail_when_the_gated_crate_is_not_allowed(self) -> None:
        self.assertNotEqual(cargo_deny("deny-missing.toml"), 0)
        result = allowlist_check("deny-missing.toml")
        self.assertEqual(result.returncode, 1)
        self.assertIn("cfg-if is in the dependency graph and is not allowed", result.stdout)

    def test_only_the_allowlist_check_fails_on_a_crate_nothing_depends_on(self) -> None:
        self.assertEqual(cargo_deny("deny-surplus.toml"), 0)
        result = allowlist_check("deny-surplus.toml")
        self.assertEqual(result.returncode, 1)
        self.assertIn("allows never-used", result.stdout)


if __name__ == "__main__":
    unittest.main()
