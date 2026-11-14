//! Which files under the corpus root are corpus files, by the one rule `conformance/README.md` states. The
//! TypeScript runner implements the same rule, and both run it over the fixture tree in
//! `conformance/fixtures/loader-selection`, so they cannot disagree.

use std::fs::{self, FileType};
use std::path::Path;

/// Directories that hold data cases refer to or the runners themselves, never cases, wherever they appear.
const NON_CASE_DIRECTORIES: [&str; 3] = ["fixtures", "schema", "runner"];

/// Whether a name uses only the characters a corpus path may, so every loader orders names the same way.
fn is_name(name: &str) -> bool {
    super::validate::is_name(name)
}

/// The files the corpus root itself holds.
const ROOT_FILES: [&str; 4] = [
    "README.md",
    "case.schema.json",
    "manifest.json",
    "manifest.schema.json",
];

/// The depth at which a directory holds corpus files: `<kind>/<name>.json`.
const AREA_DEPTH: usize = 1;

pub struct Selection {
    /// Corpus files as `/`-separated paths relative to the root, in the order a walk in UTF-16 code unit order finds them.
    pub selected: Vec<String>,
    /// Entries that are neither a corpus file, a known root file nor a skipped directory, in the same order.
    pub problems: Vec<String>,
}

fn scan(
    root: &Path,
    relative: &str,
    depth: usize,
    selection: &mut Selection,
) -> Result<(), String> {
    let directory = root.join(relative);
    let mut entries = fs::read_dir(&directory)
        .map_err(|error| format!("{}: {error}", directory.display()))?
        .map(|entry| {
            let entry = entry.map_err(|error| format!("{}: {error}", directory.display()))?;
            let kind: FileType = entry
                .file_type()
                .map_err(|error| format!("{}: {error}", entry.path().display()))?;
            Ok((entry.file_name().to_string_lossy().into_owned(), kind))
        })
        .collect::<Result<Vec<_>, String>>()?;
    // UTF-16 code unit order, the order the TypeScript loader sorts in; it differs from byte order above U+FFFF.
    entries.sort_by_cached_key(|(name, _)| name.encode_utf16().collect::<Vec<u16>>());
    for (name, kind) in entries {
        if name.starts_with('.') {
            continue;
        }
        let path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        if kind.is_dir() {
            if NON_CASE_DIRECTORIES.contains(&name.as_str()) {
                continue;
            }
            if depth < AREA_DEPTH && is_name(&name) {
                scan(root, &path, depth + 1, selection)?;
            } else {
                selection.problems.push(path);
            }
        } else if kind.is_file() && depth == 0 && ROOT_FILES.contains(&name.as_str()) {
            continue;
        } else if kind.is_file() && depth == AREA_DEPTH && name.ends_with(".json") && is_name(&name)
        {
            selection.selected.push(path);
        } else {
            selection.problems.push(path);
        }
    }
    Ok(())
}

/// Applies the selection rule to the tree at `root`. A name starting with a dot is ignored at any depth, a
/// directory named `fixtures`, `schema` or `runner` is skipped at any depth, and everything else must be a
/// `.json` file at `<kind>/<name>.json`, with names of lower-case ASCII letters, digits, dots, hyphens and underscores, or one of the root's own files; anything else is returned in
/// `problems`, for the caller to fail on.
pub fn select_corpus_files(root: &Path) -> Result<Selection, String> {
    let mut selection = Selection {
        selected: Vec::new(),
        problems: Vec::new(),
    };
    scan(root, "", 0, &mut selection)?;
    Ok(selection)
}
