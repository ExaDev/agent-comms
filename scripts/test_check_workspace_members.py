"""Tests for check-workspace-members.py, over manifest texts."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("check_workspace_members", Path(__file__).with_name("check-workspace-members.py"))
assert SPEC is not None and SPEC.loader is not None
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)

ROOT = """[workspace]
resolver = "2"
members = ["crates/*"]

[workspace.package]
edition = "2024"
rust-version = "1.99.1"
license = "MIT"

[workspace.lints.rust]
unsafe_code = "deny"
"""

GOOD = """[package]
name = "good"
version = "0.0.0"
edition.workspace = true
rust-version = { workspace = true }
license.workspace = true

[lints]
workspace = true
"""


class CheckWorkspaceMembers(unittest.TestCase):
    def test_a_crate_that_inherits_everything_passes(self) -> None:
        self.assertEqual(checker.problems_in(ROOT, {"good": GOOD}), [])

    def test_the_dotted_lints_form_passes(self) -> None:
        crate = GOOD.replace("[lints]\nworkspace = true\n", "lints.workspace = true\n")
        self.assertEqual(checker.problems_in(ROOT, {"good": crate}), [])

    def test_a_crate_without_the_lints_stanza_fails(self) -> None:
        crate = GOOD.replace("[lints]\nworkspace = true\n", "")
        self.assertEqual(checker.problems_in(ROOT, {"bad": crate}), ["bad: [lints] workspace = true is missing"])

    def test_a_lints_stanza_that_does_not_inherit_fails(self) -> None:
        crate = GOOD.replace("[lints]\nworkspace = true\n", "[lints.rust]\nunsafe_code = \"allow\"\n")
        self.assertEqual(checker.problems_in(ROOT, {"bad": crate}), ["bad: [lints] workspace = true is missing"])

    def test_a_crate_with_its_own_edition_fails(self) -> None:
        crate = GOOD.replace("edition.workspace = true", 'edition = "2021"')
        self.assertEqual(checker.problems_in(ROOT, {"bad": crate}), ["bad: edition is not inherited with edition.workspace = true"])

    def test_a_crate_without_a_licence_fails(self) -> None:
        crate = GOOD.replace("license.workspace = true\n", "")
        self.assertEqual(checker.problems_in(ROOT, {"bad": crate}), ["bad: license is not inherited with license.workspace = true"])

    def test_a_workspace_that_does_not_set_the_edition_fails(self) -> None:
        root = ROOT.replace('edition = "2024"\n', "")
        self.assertIn("[workspace.package] does not set edition", checker.problems_in(root, {"good": GOOD}))

    def test_a_workspace_without_lints_fails(self) -> None:
        root = ROOT.replace('[workspace.lints.rust]\nunsafe_code = "deny"\n', "")
        self.assertIn("[workspace.lints] is not set", checker.problems_in(root, {"good": GOOD}))

    def test_a_workspace_without_members_fails(self) -> None:
        self.assertIn("the workspace has no member crates", checker.problems_in(ROOT, {}))


if __name__ == "__main__":
    unittest.main()
