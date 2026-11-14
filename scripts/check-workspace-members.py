#!/usr/bin/env python3
"""Fails when a crate in the Rust workspace does not take its settings from the workspace.

Cargo applies `[workspace.lints]` and `[workspace.package]` to a member only when the member opts in, so a crate added without the stanzas silently escapes `unsafe_code = "deny"` and the shared edition, rust-version and licence. The members come from cargo's metadata command (through scripts/rust.sh, the one place cargo runs), which lists every crate in the workspace including path dependencies outside the `members` globs; each member's manifest must carry `[lints] workspace = true` and inherit `edition`, `rust-version` and `license`, and the workspace manifest must set each of them.

Usage: check-workspace-members.py. It needs only the standard library (Python 3.9 or later) and the Rust toolchain.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INHERITED = ("edition", "rust-version", "license")


def inherits(manifest: str, key: str) -> bool:
    """Whether the manifest takes `key` from the workspace, written `key.workspace = true` or `key = { workspace = true }`."""
    return bool(re.search(rf"^\s*{re.escape(key)}\s*(\.\s*workspace\s*=\s*true|=\s*\{{\s*workspace\s*=\s*true\s*\}})", manifest, re.MULTILINE))


def takes_lints(manifest: str) -> bool:
    """Whether the manifest has `[lints]` with `workspace = true`, or `lints.workspace = true`."""
    return bool(
        re.search(r"^\s*lints\s*\.\s*workspace\s*=\s*true", manifest, re.MULTILINE)
        or re.search(r"^\[lints\]\s*(?:#[^\n]*\n\s*)*workspace\s*=\s*true", manifest, re.MULTILINE)
    )


def section(manifest: str, header: str) -> str | None:
    """The text of the table with this exact header, up to the next table, or None when there is none."""
    match = re.search(rf"^\[{re.escape(header)}\]\s*$(.*?)(?=^\[|\Z)", manifest, re.MULTILINE | re.DOTALL)
    return match.group(1) if match else None


def problems_in(workspace_manifest: str, members: dict[str, str]) -> list[str]:
    """What is wrong with the workspace manifest and with each member's manifest text, by member name."""
    problems: list[str] = []
    shared = section(workspace_manifest, "workspace.package")
    for key in INHERITED:
        if shared is None or not re.search(rf"^\s*{re.escape(key)}\s*=", shared, re.MULTILINE):
            problems.append(f"[workspace.package] does not set {key}")
    if not re.search(r"^\[workspace\.lints", workspace_manifest, re.MULTILINE):
        problems.append("[workspace.lints] is not set")
    if not members:
        problems.append("the workspace has no member crates")
    for name, manifest in sorted(members.items()):
        if not takes_lints(manifest):
            problems.append(f"{name}: [lints] workspace = true is missing")
        for key in INHERITED:
            if not inherits(manifest, key):
                problems.append(f"{name}: {key} is not inherited with {key}.workspace = true")
    return problems


def main() -> int:
    output = subprocess.run(["sh", str(ROOT / "scripts" / "rust.sh"), "metadata"], check=True, capture_output=True, text=True).stdout
    metadata = json.loads(output)
    members = {package["name"]: Path(package["manifest_path"]).read_text() for package in metadata["packages"]}
    problems = problems_in((Path(metadata["workspace_root"]) / "Cargo.toml").read_text(), members)
    for problem in problems:
        print(problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
