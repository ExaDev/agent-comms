#!/usr/bin/env python3
"""Fails when the pinned cargo-deny version is behind a newer release that is older than the cooldown.

Dependabot reads the Cargo.lock and the toolchain file, but not the `tool: cargo-deny@X` string the workflows install the tool with, so nothing would ever bump that pin. This compares it with crates.io: the newest release published at least COOLDOWN_DAYS ago must not be newer than the pin, the seven-day release age the global package install policy applies to every other dependency. It also fails when the workflows pin different versions.

Usage: check-tool-pins.py. It reads the workflows, and crates.io over the network.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

COOLDOWN_DAYS = 7
WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"
CRATES_IO = "https://crates.io/api/v1/crates/cargo-deny"

Version = tuple[int, ...]


def parse_version(text: str) -> Version | None:
    """The numeric version, or None for a pre-release or anything not `X.Y.Z`."""
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", text)
    return tuple(int(part) for part in match.groups()) if match else None


def pins_in(workflows: Path) -> dict[str, set[str]]:
    """Each cargo-deny version pinned, with the workflow files that pin it."""
    pins: dict[str, set[str]] = {}
    for workflow in sorted(workflows.glob("*.yml")):
        for version in re.findall(r"cargo-deny@([0-9][^\s\"']*)", workflow.read_text()):
            pins.setdefault(version, set()).add(workflow.name)
    return pins


def newer_eligible(current: Version, releases: list[dict[str, object]], now: datetime) -> Version | None:
    """The newest release newer than `current` that was published at least the cooldown ago, if any."""
    cutoff = now - timedelta(days=COOLDOWN_DAYS)
    eligible: list[Version] = []
    for release in releases:
        version = parse_version(str(release["num"]))
        published = datetime.fromisoformat(str(release["created_at"]).replace("Z", "+00:00"))
        if version is not None and not release.get("yanked") and published <= cutoff and version > current:
            eligible.append(version)
    return max(eligible, default=None)


def main() -> int:
    pins = pins_in(WORKFLOWS)
    if not pins:
        print("no cargo-deny pin found in the workflows")
        return 1
    if len(pins) > 1:
        print(f"the workflows pin different cargo-deny versions: { {version: sorted(files) for version, files in pins.items()} }")
        return 1
    (pinned,) = pins
    current = parse_version(pinned)
    if current is None:
        print(f"cargo-deny is pinned to {pinned}, which is not an exact release")
        return 1
    request = urllib.request.Request(CRATES_IO, headers={"User-Agent": "tool-pin-check"})
    with urllib.request.urlopen(request, timeout=30) as response:
        releases = json.load(response)["versions"]
    newer = newer_eligible(current, releases, datetime.now(timezone.utc))
    if newer is not None:
        print(f"cargo-deny is pinned to {pinned}, and {'.'.join(map(str, newer))} has been out for more than {COOLDOWN_DAYS} days")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
