#!/usr/bin/env python3
"""Fails when rust/deny.toml allows a crate that cargo-deny does not find in the dependency graph.

cargo-deny fails a crate that is missing from the allowlist, but reports an allowlisted crate that nothing uses only as a note: it has no option to make that an error, so the allowlist could grow wider than the graph without any review of the file. This closes the other direction, and takes the graph from the tool that enforces it: the crates cargo-deny itself reports as explicitly allowed (every platform and every feature, as the [graph] table in deny.toml says, and cfg edges evaluated the way cargo-deny evaluates them). A second definition of the graph, from the tree or metadata commands of cargo, disagrees with the enforcing one for any platform-gated crate, and no deny.toml could satisfy both.

Usage: check-deny-allowlist.py [--manifest FILE] [--config FILE]. It runs cargo-deny through scripts/rust.sh, which runs from rust/ so the pinned toolchain applies, against the committed Cargo.lock. It needs only the standard library (Python 3.9 or later).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RUST = ROOT / "rust"
CRATE = re.compile(r"crate '([^' ]+) = ")


def allowed_names(config: Path) -> set[str]:
    """The names under `[bans] allow`, each written `{ crate = "name", ... }` or as a bare string.

    The file is read as text, since parsing TOML needs Python 3.11; the rule it relies on is the layout deny.toml states, one entry per line inside the `allow = [` array of the `[bans]` table.
    """
    text = config.read_text()
    bans = re.search(r"^\[bans\]\s*$(.*?)(?=^\[|\Z)", text, re.MULTILINE | re.DOTALL)
    block = re.search(r"^allow\s*=\s*\[(.*?)^\]", bans.group(1) if bans else "", re.MULTILINE | re.DOTALL)
    if block is None:
        raise SystemExit(f"{config}: no `allow = [` array under [bans]")
    names: set[str] = set()
    for line in block.group(1).splitlines():
        entry = re.match(r"\s*(?:\{\s*crate\s*=\s*)?\"([^\"]+)\"", line)
        if entry:
            names.add(entry.group(1))
    return names


def entries_without_reason(config: Path) -> set[str]:
    """The names under `[bans] allow` whose entry does not give a non-empty `reason`, which every entry must, so adding a dependency is a reviewed change with the reason it is needed."""
    text = config.read_text()
    bans = re.search(r"^\[bans\]\s*$(.*?)(?=^\[|\Z)", text, re.MULTILINE | re.DOTALL)
    block = re.search(r"^allow\s*=\s*\[(.*?)^\]", bans.group(1) if bans else "", re.MULTILINE | re.DOTALL)
    missing: set[str] = set()
    for line in block.group(1).splitlines() if block else []:
        entry = re.match(r"\s*(?:\{\s*crate\s*=\s*)?\"([^\"]+)\"", line)
        if entry and not re.search(r"reason\s*=\s*\"[^\"]+\"", line):
            missing.add(entry.group(1))
    return missing


def diagnostics(manifest: Path, config: Path) -> list[dict[str, object]]:
    """The bans diagnostics cargo-deny prints, as JSON lines on stderr, whatever its exit status."""
    result = subprocess.run(
        ["sh", str(ROOT / "scripts" / "rust.sh"), "deny-bans-json", str(manifest), str(config)],
        check=False,
        capture_output=True,
        text=True,
    )
    found: list[dict[str, object]] = []
    for line in result.stderr.splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("type") == "diagnostic":
            found.append(record["fields"])
    if not found:
        raise SystemExit(f"cargo-deny reported no diagnostics for {config}: {result.stderr[:500]}")
    return found


def crates_with_code(found: list[dict[str, object]], code: str) -> set[str]:
    """The names of the crates the diagnostics with this code are about (`crate 'name = 1.2.3' is ...`)."""
    names: set[str] = set()
    for record in found:
        match = CRATE.match(str(record.get("message", "")))
        if record.get("code") == code and match:
            names.add(match.group(1))
    return names


def main(arguments: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_RUST / "Cargo.toml")
    parser.add_argument("--config", type=Path, default=DEFAULT_RUST / "deny.toml")
    args = parser.parse_args(arguments)
    config = args.config.resolve()
    found = diagnostics(args.manifest.resolve(), config)
    in_graph = crates_with_code(found, "allowed") | crates_with_code(found, "not-allowed")
    status = 0
    for name in sorted(allowed_names(config) - in_graph):
        print(f"{config.name} allows {name}, which cargo-deny does not find in the dependency graph")
        status = 1
    for name in sorted(entries_without_reason(config)):
        print(f"{config.name} allows {name} without a reason")
        status = 1
    for name in sorted(crates_with_code(found, "not-allowed")):
        print(f"{name} is in the dependency graph and is not allowed by {config.name}")
        status = 1
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
