//! Loads the conformance corpus (`conformance/` at the repository root) and checks it against the format in
//! `conformance/README.md` and `conformance/case.schema.json`, by the same rules the TypeScript runner applies:
//! which files are corpus files, what a valid file is, and that the corpus is what `conformance/manifest.json`
//! says it is. A file that does not match is a failure, never a skip.
//!
//! The loader executes no case: it proves that the Rust side reads the same files, selected the same way, as the
//! TypeScript runner does, and counts every case it does not execute as skipped.

mod selection;
mod validate;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde_json::Value;

fn corpus_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance")
}

/// A corpus file or manifest: its keys must be in canonical order in the text, which no parsed value shows, and then
/// it is read as any JSON is.
fn read_corpus_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if let Some(problem) = validate::key_order_problem(&text) {
        return Err(format!("{}: {problem}", path.display()));
    }
    serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))
}

fn string_list(value: &Value, what: &str) -> Result<Vec<String>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("{what}: expected a list"))?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("{what}: expected a list of strings"))
        })
        .collect()
}

/// The shared fixture tree must be selected exactly as `expected.json` says.
fn check_selection_fixture(failures: &mut Vec<String>) {
    let directory = corpus_root().join("fixtures/loader-selection");
    let result = read_json(&directory.join("expected.json")).and_then(|expected| {
        let found = selection::select_corpus_files(&directory.join("tree"))?;
        let want_selected = string_list(&expected["selected"], "selected")?;
        let want_problems = string_list(&expected["problems"], "problems")?;
        if found.selected == want_selected && found.problems == want_problems {
            Ok(())
        } else {
            Err(format!(
                "loader-selection: selected {:?} and problems {:?}, expected {want_selected:?} and {want_problems:?}",
                found.selected, found.problems
            ))
        }
    });
    if let Err(error) = result {
        failures.push(error);
    }
}

/// The names in a fixture directory, sorted; a directory with none is a failure, since a loop over nothing passes.
fn fixture_names(relative: &str, failures: &mut Vec<String>) -> Vec<String> {
    let directory = corpus_root().join("fixtures").join(relative);
    let mut names = match fs::read_dir(&directory) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        Err(error) => {
            failures.push(format!("{}: {error}", directory.display()));
            return Vec::new();
        }
    };
    names.sort();
    if names.is_empty() {
        failures.push(format!("fixtures/{relative} holds no fixtures"));
    }
    names
}

/// Whether a loader rejects the file. A file that cannot be parsed is rejected too: it is how this loader meets an
/// unpaired surrogate escape.
fn rejects<T>(path: &Path, validate: &impl Fn(&Value) -> Result<T, String>) -> bool {
    read_corpus_json(path).map_or(true, |value| validate(&value).is_err())
}

/// A negative fixture must fail for the rule it exists for. Each file in `invalid` has a file of the same name in
/// `repaired` that differs by that one defect and is valid, so the invalid one cannot stay rejected for another
/// reason.
fn check_pairs<T>(
    invalid: &str,
    repaired: &str,
    validate: impl Fn(&Value) -> Result<T, String>,
    failures: &mut Vec<String>,
) {
    let names = fixture_names(invalid, failures);
    if fixture_names(repaired, failures) != names {
        failures.push(format!(
            "fixtures/{repaired} and fixtures/{invalid} do not hold the same names"
        ));
    }
    let root = corpus_root().join("fixtures");
    for name in names {
        if !rejects(&root.join(invalid).join(&name), &validate) {
            failures.push(format!("{invalid}/{name} validated, and must not"));
        }
        if let Err(error) =
            read_corpus_json(&root.join(repaired).join(&name)).and_then(|value| validate(&value))
        {
            failures.push(format!("{repaired}/{name} must validate: {error}"));
        }
    }
}

/// Every file in the directory is valid and must be accepted.
fn check_accepted<T>(
    relative: &str,
    validate: impl Fn(&Value) -> Result<T, String>,
    failures: &mut Vec<String>,
) {
    let root = corpus_root().join("fixtures").join(relative);
    for name in fixture_names(relative, failures) {
        if let Err(error) = read_corpus_json(&root.join(&name)).and_then(|value| validate(&value)) {
            failures.push(format!("{relative}/{name} must validate: {error}"));
        }
    }
}

/// Each whole-corpus fixture has a problem, and its repaired twin has none.
fn check_corpus_pairs(failures: &mut Vec<String>) {
    let names = fixture_names("corpora/invalid", failures);
    if fixture_names("corpora/repaired", failures) != names {
        failures.push(
            "fixtures/corpora/repaired and fixtures/corpora/invalid do not hold the same names"
                .to_owned(),
        );
    }
    let root = corpus_root().join("fixtures/corpora");
    for name in names {
        if check_corpus(&root.join("invalid").join(&name)).1.is_empty() {
            failures.push(format!("corpora/invalid/{name} has no problem, and must"));
        }
        for problem in check_corpus(&root.join("repaired").join(&name)).1 {
            failures.push(format!("corpora/repaired/{name}: {problem}"));
        }
    }
}

/// Both forms of a text denote the same UTF-16 code units.
fn check_text_pairs(failures: &mut Vec<String>) {
    let path = corpus_root().join("fixtures/text-forms/pairs.json");
    let result = read_json(&path).and_then(|document| {
        let pairs = document["pairs"]
            .as_array()
            .filter(|pairs| !pairs.is_empty());
        let pairs = pairs.ok_or("pairs.json must hold a non-empty list of pairs")?;
        for pair in pairs {
            let from_text = validate::decode_text(&pair["text"], "text")?;
            let from_units = validate::decode_text(
                &serde_json::json!({ "codeUnits": pair["codeUnits"] }),
                "codeUnits",
            )?;
            if from_text != from_units {
                return Err(format!(
                    "text {} is {from_text:?}, its code units are {from_units:?}",
                    pair["text"]
                ));
            }
        }
        Ok(())
    });
    if let Err(error) = result {
        failures.push(format!("fixtures/text-forms/pairs.json: {error}"));
    }
}

struct LoadedFile {
    name: String,
    case_count: usize,
    skip_ids: Vec<String>,
    rust_skip_ids: Vec<String>,
}

/// Loads and checks a whole corpus root by every rule `conformance/README.md` states: the files selected, each file
/// valid, ids unique across files, and the corpus equal to its manifest. The real corpus and every fixture corpus go
/// through this one function.
fn check_corpus(root: &Path) -> (Vec<LoadedFile>, Vec<String>) {
    let mut problems = Vec::new();
    let found = match selection::select_corpus_files(root) {
        Ok(found) => found,
        Err(error) => return (Vec::new(), vec![error]),
    };
    for problem in &found.problems {
        problems.push(format!(
            "{problem}: not a corpus file and not a recognised root file"
        ));
    }
    let mut files = Vec::new();
    let mut ids = BTreeSet::new();
    for name in found.selected {
        let facts = read_corpus_json(&root.join(&name)).and_then(|value| {
            validate::validate_file(&value).map_err(|error| format!("{name}: {error}"))
        });
        match facts {
            Ok(facts) => {
                let directory = name.split('/').next().unwrap_or_default();
                for (id, kind) in facts.ids.iter().zip(&facts.kinds) {
                    if kind != directory {
                        problems.push(format!(
                            "{name}: case {id} is of kind {kind}, and the directory names kind {directory}"
                        ));
                    }
                    if !ids.insert(id.clone()) {
                        problems.push(format!("{name}: case id {id} is used by another file"));
                    }
                }
                files.push(LoadedFile {
                    name,
                    case_count: facts.ids.len(),
                    skip_ids: facts.skip_ids,
                    rust_skip_ids: facts.rust_skip_ids,
                });
            }
            Err(error) => problems.push(error),
        }
    }
    match read_corpus_json(&root.join("manifest.json"))
        .and_then(|value| validate::validate_manifest(&value))
    {
        Ok(manifest) => {
            problems.extend(count_problems(&files, &manifest));
            let actual: BTreeMap<&str, (usize, &Vec<String>)> = files
                .iter()
                .map(|file| (file.name.as_str(), (file.case_count, &file.skip_ids)))
                .collect();
            let recorded: BTreeMap<&str, (usize, &Vec<String>)> = manifest
                .iter()
                .map(|(name, (count, skip))| (name.as_str(), (*count, skip)))
                .collect();
            for name in actual
                .keys()
                .chain(recorded.keys())
                .collect::<BTreeSet<_>>()
            {
                if actual.get(*name) != recorded.get(*name) {
                    problems.push(format!(
                        "manifest.json does not match {name}: the file holds {:?}, the manifest records {:?}",
                        actual.get(*name),
                        recorded.get(*name)
                    ));
                }
            }
        }
        Err(error) => problems.push(format!("manifest.json: {error}")),
    }
    (files, problems)
}

/// The completeness check for this implementation, the same rule as the TypeScript runner's `completenessProblems`:
/// what is executed plus what is skipped is the manifest's total, and every case skipped because it is marked for this
/// implementation (`skip: rust`) is marked in the manifest. Every other case is skipped for want of a native
/// executor, a reason counted apart, so a case an executor takes over moves from skipped to executed and is never lost.
fn count_problems(
    files: &[LoadedFile],
    manifest: &BTreeMap<String, (usize, Vec<String>)>,
) -> Vec<String> {
    let (executed, skipped_marked, skipped_without_executor) = counts(files);
    let total: usize = manifest.values().map(|(count, _)| count).sum();
    let marked: BTreeSet<&String> = manifest.values().flat_map(|(_, skip)| skip).collect();
    let mut problems = Vec::new();
    if executed + skipped_marked + skipped_without_executor != total {
        problems.push(format!(
            "executed {executed} plus skipped {} is not the manifest's {total}",
            skipped_marked + skipped_without_executor
        ));
    }
    for id in files.iter().flat_map(|file| &file.rust_skip_ids) {
        if !marked.contains(id) {
            problems.push(format!(
                "{id} is skipped here because it is marked, and the manifest does not mark it"
            ));
        }
    }
    problems
}

/// The cases this runner executed, skipped because they are marked `rust`, and skipped for want of an executor.
fn counts(files: &[LoadedFile]) -> (usize, usize, usize) {
    let total: usize = files.iter().map(|file| file.case_count).sum();
    let skipped_marked: usize = files.iter().map(|file| file.rust_skip_ids.len()).sum();
    (0, skipped_marked, total - skipped_marked)
}

fn main() -> ExitCode {
    let mut failures = Vec::new();
    check_selection_fixture(&mut failures);
    check_pairs(
        "invalid-cases",
        "repaired-cases",
        validate::validate_file,
        &mut failures,
    );
    check_accepted("valid-cases", validate::validate_file, &mut failures);
    check_pairs(
        "manifests/invalid",
        "manifests/repaired",
        validate::validate_manifest,
        &mut failures,
    );
    check_accepted(
        "manifests/valid",
        validate::validate_manifest,
        &mut failures,
    );
    check_corpus_pairs(&mut failures);
    check_text_pairs(&mut failures);
    validate::self_check(&mut failures);
    let (files, problems) = check_corpus(&corpus_root());
    failures.extend(problems);
    let (executed, skipped_marked, skipped_without_executor) = counts(&files);
    for file in &files {
        println!(
            "{}: {} cases ({} carrying skip)",
            file.name,
            file.case_count,
            file.skip_ids.len()
        );
    }
    for failure in &failures {
        eprintln!("FAIL {failure}");
    }
    if failures.is_empty() {
        println!(
            "checked {} files: {executed} executed, {skipped_marked} skipped because they carry skip: rust, {skipped_without_executor} skipped for want of a native executor",
            files.len()
        );
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
