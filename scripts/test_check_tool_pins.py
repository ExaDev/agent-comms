"""Tests for check-tool-pins.py: the cooldown and version rules, with no network."""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("check_tool_pins", Path(__file__).with_name("check-tool-pins.py"))
assert SPEC is not None and SPEC.loader is not None
pins = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pins)

NOW = datetime(2026, 11, 13, tzinfo=timezone.utc)


def release(num: str, created: str, yanked: bool = False) -> dict[str, object]:
    return {"num": num, "created_at": created, "yanked": yanked}


class NewerEligible(unittest.TestCase):
    def test_a_newer_release_past_the_cooldown_is_reported(self) -> None:
        releases = [release("0.20.2", "2026-07-09T00:00:00Z"), release("0.21.0", "2026-10-01T00:00:00Z")]
        self.assertEqual(pins.newer_eligible((0, 20, 2), releases, NOW), (0, 21, 0))

    def test_a_newer_release_inside_the_cooldown_is_not(self) -> None:
        releases = [release("0.21.0", "2026-11-10T00:00:00Z")]
        self.assertIsNone(pins.newer_eligible((0, 20, 2), releases, NOW))

    def test_the_pin_itself_and_older_releases_are_not(self) -> None:
        releases = [release("0.20.2", "2026-07-09T00:00:00Z"), release("0.19.9", "2026-06-15T00:00:00Z")]
        self.assertIsNone(pins.newer_eligible((0, 20, 2), releases, NOW))

    def test_a_yanked_or_pre_release_version_is_ignored(self) -> None:
        releases = [release("0.21.0", "2026-10-01T00:00:00Z", yanked=True), release("0.22.0-rc.1", "2026-10-01T00:00:00Z")]
        self.assertIsNone(pins.newer_eligible((0, 20, 2), releases, NOW))

    def test_the_newest_eligible_release_wins(self) -> None:
        releases = [release("0.21.0", "2026-09-01T00:00:00Z"), release("0.21.3", "2026-10-01T00:00:00Z"), release("0.22.0", "2026-11-12T00:00:00Z")]
        self.assertEqual(pins.newer_eligible((0, 20, 2), releases, NOW), (0, 21, 3))


class PinsIn(unittest.TestCase):
    def test_every_pin_is_found_with_its_workflow(self) -> None:
        directory = Path(tempfile.mkdtemp())
        (directory / "a.yml").write_text("      - uses: taiki-e/install-action@v2\n        with:\n          tool: cargo-deny@0.20.2\n")
        (directory / "b.yml").write_text("          tool: cargo-deny@0.19.0\n")
        self.assertEqual(pins.pins_in(directory), {"0.20.2": {"a.yml"}, "0.19.0": {"b.yml"}})


if __name__ == "__main__":
    unittest.main()
