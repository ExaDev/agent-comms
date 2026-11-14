//! Validation of corpus files and the manifest, by hand, beside the schema it must agree with. It
//! accepts exactly what `conformance/case.schema.json` accepts and rejects every case kind it does not validate
//! in full, rather than passing it unchecked: a loader that cannot judge a case must not say it is fine.
//!
//! Strings in the corpus are sequences of UTF-16 code units. A JSON string is read by `serde_json`, which refuses
//! an unpaired surrogate escape, so the file holding one does not load and is rejected; content that needs one is
//! written as `{ "codeUnits": [...] }`, which `decode_text` reads into the same `u16` sequence a JSON string gives.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

type Check<T> = Result<T, String>;

/// The largest value of a UTF-16 code unit, which bounds a literal's `codeUnit` and a range's ends.
const MAX_CODE_UNIT: u64 = 65535;

/// The largest integer a JSON number holds exactly in the JavaScript runners, and so the largest the format allows.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Whether a name (a case id, or a directory or file name of a corpus file) uses only lower-case ASCII letters,
/// digits, dots, hyphens and underscores, and does not start with a punctuation character, so every loader orders
/// names the same way.
pub fn is_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
        })
}

/// Whether a case's `from` is an original test title (`<test file>.test.ts: <title>`, or `.test.tsx`) or a recorded
/// behaviour (`recorded: <what>`), so a reader can tell a pinned original from a recorded one.
fn is_valid_from(from: &str) -> bool {
    // The schema's pattern matches the text after the colon with `.`, which no line terminator satisfies.
    let has_line_terminator = from.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    if has_line_terminator {
        return false;
    }
    if let Some(rest) = from.strip_prefix("recorded: ") {
        return !rest.is_empty();
    }
    from.split_once(": ").is_some_and(|(file, title)| {
        let stem = file
            .strip_suffix(".test.ts")
            .or_else(|| file.strip_suffix(".test.tsx"));
        !title.is_empty()
            && stem.is_some_and(|stem| {
                !stem.is_empty()
                    && stem.bytes().all(|byte| {
                        byte.is_ascii_lowercase()
                            || byte.is_ascii_digit()
                            || matches!(byte, b'.' | b'_' | b'-')
                    })
            })
    })
}

/// A string as the UTF-16 code units it denotes: a JSON string, or `{ "codeUnits": [...] }` for content a JSON
/// string cannot carry. The second form is what lets a case hold an unpaired surrogate.
pub fn decode_text(value: &Value, at: &str) -> Check<Vec<u16>> {
    if let Some(text) = value.as_str() {
        return Ok(text.encode_utf16().collect());
    }
    let map = exact_keys(value, at, &["codeUnits"], &[])?;
    array(&map["codeUnits"], at, "\"codeUnits\"")?
        .iter()
        .map(|unit| {
            as_integer(unit)
                .and_then(|unit| u16::try_from(unit).ok())
                .ok_or_else(|| {
                    format!("{at}: a code unit must be an integer from 0 to {MAX_CODE_UNIT}")
                })
        })
        .collect()
}

const COMMON_KEYS: [&str; 3] = ["id", "from", "kind"];
const OPTIONAL_COMMON_KEYS: [&str; 2] = ["skip", "reason"];

fn object<'a>(value: &'a Value, at: &str) -> Check<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| format!("{at}: expected an object"))
}

fn array<'a>(value: &'a Value, at: &str, what: &str) -> Check<&'a Vec<Value>> {
    value
        .as_array()
        .ok_or_else(|| format!("{at}: {what} must be an array"))
}

/// The object at `at`, holding every key in `required`, and no key outside `required` and `optional`.
fn exact_keys<'a>(
    value: &'a Value,
    at: &str,
    required: &[&str],
    optional: &[&str],
) -> Check<&'a Map<String, Value>> {
    let map = object(value, at)?;
    for key in required {
        if !map.contains_key(*key) {
            return Err(format!("{at}: missing \"{key}\""));
        }
    }
    for key in map.keys() {
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            return Err(format!("{at}: unexpected \"{key}\""));
        }
    }
    Ok(map)
}

fn string_field<'a>(map: &'a Map<String, Value>, key: &str, at: &str) -> Check<&'a str> {
    map.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{at}: \"{key}\" must be a string"))
}

fn non_empty_string_field<'a>(map: &'a Map<String, Value>, key: &str, at: &str) -> Check<&'a str> {
    let text = string_field(map, key, at)?;
    if text.is_empty() {
        return Err(format!("{at}: \"{key}\" must not be empty"));
    }
    Ok(text)
}

/// A non-negative JSON integer. Like JSON Schema's `integer`, `97.0` is one, and `97.5` is not.
fn as_integer(value: &Value) -> Option<u64> {
    let integer = if let Some(integer) = value.as_u64() {
        integer
    } else {
        let float = value.as_f64()?;
        if !(float >= 0.0 && float.fract() == 0.0 && float <= MAX_SAFE_INTEGER as f64) {
            return None;
        }
        // The checks above bound the value to a non-negative whole number below 2^53, which `u64` holds exactly.
        float as u64
    };
    (integer <= MAX_SAFE_INTEGER).then_some(integer)
}

fn integer_field(map: &Map<String, Value>, key: &str, at: &str) -> Check<u64> {
    map.get(key)
        .and_then(as_integer)
        .ok_or_else(|| format!("{at}: \"{key}\" must be a non-negative integer"))
}

/// Any JSON value whose numbers are integers of at most 2^53-1 in magnitude, and whose objects holding a `codeUnits`
/// key are exactly the code unit form of a string.
fn check_value(value: &Value, at: &str) -> Check<()> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(()),
        Value::Number(_) => as_safe_integer(value).map(drop).ok_or_else(|| {
            format!("{at}: a number must be an integer of at most 2^53-1 in magnitude")
        }),
        Value::Array(items) => items.iter().try_for_each(|item| check_value(item, at)),
        Value::Object(map) => {
            if map.contains_key("codeUnits") {
                decode_text(value, at).map(drop)
            } else if map.contains_key("$number") {
                decode_special_number(value, at).map(drop)
            } else {
                map.values().try_for_each(|item| check_value(item, at))
            }
        }
    }
}

/// The four numbers the canonical form cannot hold, by the names a corpus file gives them. A closed lookup: any other
/// name is refused, never read as a number.
pub fn decode_special_number(value: &Value, at: &str) -> Check<f64> {
    let map = exact_keys(value, at, &["$number"], &[])?;
    match map["$number"].as_str() {
        Some("-0") => Ok(-0.0),
        Some("Infinity") => Ok(f64::INFINITY),
        Some("-Infinity") => Ok(f64::NEG_INFINITY),
        Some("NaN") => Ok(f64::NAN),
        _ => Err(format!(
            "{at}: \"$number\" must be \"-0\", \"Infinity\", \"-Infinity\" or \"NaN\""
        )),
    }
}

/// An integer of either sign. Like JSON Schema's `integer`, `97.0` is one, and `97.5` is not.
fn as_safe_integer(value: &Value) -> Option<i64> {
    let limit = MAX_SAFE_INTEGER as i64;
    let integer = if let Some(integer) = value.as_i64() {
        integer
    } else if value.as_u64().is_some() {
        return None;
    } else {
        let float = value.as_f64()?;
        if !(float.fract() == 0.0 && float.abs() <= MAX_SAFE_INTEGER as f64) {
            return None;
        }
        // The checks above bound the value to a whole number inside the safe range, which `i64` holds exactly.
        float as i64
    };
    (integer.abs() <= limit).then_some(integer)
}

/// A list of message fragments: not empty, and each fragment a non-empty text.
fn check_fragments(value: &Value, at: &str) -> Check<()> {
    let fragments = array(value, at, "\"message\"")?;
    if fragments.is_empty() {
        return Err(format!("{at}: \"message\" must not be empty"));
    }
    for fragment in fragments {
        if decode_text(fragment, at)?.is_empty() {
            return Err(format!("{at}: \"message\" must hold non-empty texts"));
        }
    }
    Ok(())
}

fn check_function_case(value: &Value, at: &str) -> Check<()> {
    let expectations = ["expect", "expectSubset", "expectUndefined", "throws"];
    let map = exact_keys(
        value,
        at,
        &[COMMON_KEYS.as_slice(), &["function", "args"]].concat(),
        &[OPTIONAL_COMMON_KEYS.as_slice(), &expectations].concat(),
    )?;
    non_empty_string_field(map, "function", at)?;
    array(&map["args"], at, "\"args\"")?
        .iter()
        .try_for_each(|arg| check_value(arg, at))?;
    let given = expectations
        .iter()
        .filter(|key| map.contains_key(**key))
        .count();
    if given != 1 {
        return Err(format!(
            "{at}: exactly one of expect, expectSubset, expectUndefined and throws is required"
        ));
    }
    if let Some(expect) = map.get("expect") {
        check_value(expect, at)?;
    }
    if let Some(subset) = map.get("expectSubset") {
        check_value(subset, at)?;
    }
    if let Some(flag) = map.get("expectUndefined")
        && flag != &Value::Bool(true)
    {
        return Err(format!("{at}: \"expectUndefined\" must be true"));
    }
    if let Some(throws) = map.get("throws") {
        let throws = exact_keys(throws, at, &[], &["code", "message"])?;
        if throws.contains_key("code") {
            non_empty_string_field(throws, "code", at)?;
        }
        if let Some(message) = throws.get("message") {
            check_fragments(message, at)?;
        }
    }
    Ok(())
}

fn check_validate_case(value: &Value, at: &str) -> Check<()> {
    let map = exact_keys(
        value,
        at,
        &[COMMON_KEYS.as_slice(), &["schema", "input", "expect"]].concat(),
        &OPTIONAL_COMMON_KEYS,
    )?;
    non_empty_string_field(map, "schema", at)?;
    check_value(&map["input"], at)?;
    let expect = object(&map["expect"], at)?;
    match expect.get("ok") {
        Some(Value::Bool(true)) => {
            exact_keys(&map["expect"], at, &["ok"], &["value"])?;
            if let Some(value) = expect.get("value") {
                check_value(value, at)?;
            }
            Ok(())
        }
        Some(Value::Bool(false)) => {
            exact_keys(&map["expect"], at, &["ok", "issues"], &[])?;
            let issues = array(&expect["issues"], at, "\"issues\"")?;
            if issues.is_empty() {
                return Err(format!("{at}: \"issues\" must not be empty"));
            }
            for issue in issues {
                let issue_map = exact_keys(issue, at, &["path"], &["code", "message"])?;
                if issue_map.contains_key("code") {
                    non_empty_string_field(issue_map, "code", at)?;
                }
                for step in array(&issue_map["path"], at, "\"path\"")? {
                    if !(step.is_string() || as_integer(step).is_some()) {
                        return Err(format!(
                            "{at}: a path step is a string or a non-negative integer"
                        ));
                    }
                }
                if let Some(message) = issue_map.get("message") {
                    check_fragments(message, at)?;
                }
            }
            Ok(())
        }
        _ => Err(format!("{at}: \"expect\" needs \"ok\" to be true or false")),
    }
}

/// Checks one case and returns its id and kind. Only the kinds this loader validates in full are accepted, even one
/// the schema defines, because a case this loader cannot judge must not read as accepted.
fn check_case(value: &Value, at: &str) -> Check<(String, String)> {
    let map = object(value, at)?;
    for key in COMMON_KEYS {
        if !map.contains_key(key) {
            return Err(format!("{at}: missing \"{key}\""));
        }
    }
    let id = non_empty_string_field(map, "id", at)?;
    if !is_name(id) {
        return Err(format!(
            "{at}: a case id uses lower-case ASCII letters, digits, dots, hyphens and underscores"
        ));
    }
    if !is_valid_from(non_empty_string_field(map, "from", at)?) {
        return Err(format!(
            "{at}: \"from\" must be \"<test file>.test.ts: <title>\" or \"recorded: <what>\""
        ));
    }
    if let Some(skip) = map.get("skip")
        && !matches!(skip.as_str(), Some("ts" | "rust"))
    {
        return Err(format!("{at}: \"skip\" must be \"ts\" or \"rust\""));
    }
    if map.contains_key("skip") != map.contains_key("reason") {
        return Err(format!("{at}: \"skip\" and \"reason\" go together"));
    }
    if map.contains_key("reason") {
        non_empty_string_field(map, "reason", at)?;
    }
    let kind = string_field(map, "kind", at)?;
    match kind {
        "function" => check_function_case(value, at)?,
        "validate" => check_validate_case(value, at)?,
        other => {
            return Err(format!(
                "{at}: the {other} kind is not validated by this loader, and an unchecked case is not accepted"
            ));
        }
    }
    Ok((id.to_owned(), kind.to_owned()))
}

/// What a valid corpus file holds, for the checks that compare files with each other and with the manifest.
pub struct FileFacts {
    pub ids: Vec<String>,
    /// The kind of each case, in the order of `ids`.
    pub kinds: Vec<String>,
    /// The ids of the cases carrying skip, sorted.
    pub skip_ids: Vec<String>,
    /// The ids of the cases marked `rust`, the ones this implementation skips because they are marked, sorted.
    pub rust_skip_ids: Vec<String>,
}

pub fn validate_file(value: &Value) -> Check<FileFacts> {
    let top = exact_keys(value, "file", &["cases"], &[])?;
    let cases = array(&top["cases"], "file", "\"cases\"")?;
    if cases.is_empty() {
        return Err("file: \"cases\" must not be empty".to_owned());
    }
    let mut facts = FileFacts {
        ids: Vec::new(),
        kinds: Vec::new(),
        skip_ids: Vec::new(),
        rust_skip_ids: Vec::new(),
    };
    let mut seen = BTreeSet::new();
    for (position, case) in cases.iter().enumerate() {
        let (id, kind) = check_case(case, &format!("case {position}"))?;
        if !seen.insert(id.clone()) {
            return Err(format!("case id {id} is used twice in the file"));
        }
        if case.get("skip").is_some() {
            facts.skip_ids.push(id.clone());
        }
        if case.get("skip").and_then(Value::as_str) == Some("rust") {
            facts.rust_skip_ids.push(id.clone());
        }
        facts.ids.push(id);
        facts.kinds.push(kind);
    }
    facts.skip_ids.sort();
    facts.rust_skip_ids.sort();
    Ok(facts)
}

/// The manifest as a map from corpus file to its case count and the ids carrying skip.
pub fn validate_manifest(value: &Value) -> Check<BTreeMap<String, (usize, Vec<String>)>> {
    let top = exact_keys(value, "manifest", &["files"], &[])?;
    let files = object(&top["files"], "manifest")?;
    if files.is_empty() {
        return Err("manifest: \"files\" must not be empty".to_owned());
    }
    let mut manifest = BTreeMap::new();
    for (name, entry) in files {
        let at = format!("manifest {name}");
        let parts: Vec<&str> = name.split('/').collect();
        if parts.len() != 2 || !parts.iter().all(|part| is_name(part)) || !name.ends_with(".json") {
            return Err(format!("{at}: a corpus file is named <kind>/<name>.json"));
        }
        let map = exact_keys(entry, &at, &["cases", "skip"], &[])?;
        let count = integer_field(map, "cases", &at)?;
        if count == 0 {
            return Err(format!("{at}: \"cases\" must be at least 1"));
        }
        let mut skip = Vec::new();
        for id in array(&map["skip"], &at, "\"skip\"")? {
            skip.push(
                id.as_str()
                    .filter(|text| is_name(text))
                    .ok_or_else(|| format!("{at}: \"skip\" must hold case ids"))?
                    .to_owned(),
            );
        }
        if !skip.windows(2).all(|pair| pair[0] < pair[1]) {
            return Err(format!(
                "{at}: \"skip\" must list distinct ids in ascending order"
            ));
        }
        let count = usize::try_from(count).map_err(|error| format!("{at}: {error}"))?;
        manifest.insert(name.clone(), (count, skip));
    }
    Ok(manifest)
}

/// Checks the validator against documents written here rather than read from the corpus, for what a JSON file
/// cannot hold: the corpus is canonical JSON, which writes `97.0` as `97`.
pub fn self_check(failures: &mut Vec<String>) {
    let value = |text: &str| {
        serde_json::from_str::<Value>(text).map(|value| check_value(&value, "self-check"))
    };
    match value("[97.0, -97.0]") {
        Ok(Ok(())) => {}
        other => failures.push(format!(
            "self-check: 97.0 must be accepted as an integer, got {other:?}"
        )),
    }
    match value(r#"[{"$number": "-0"}, {"$number": "NaN"}]"#) {
        Ok(Ok(())) => {}
        other => failures.push(format!(
            "self-check: the special numbers must be accepted, got {other:?}"
        )),
    }
    match value(r#"[{"$number": "1"}]"#) {
        Ok(Err(_)) => {}
        other => failures.push(format!(
            "self-check: an unknown $number name must be refused, got {other:?}"
        )),
    }
    match value("[97.5]") {
        Ok(Err(_)) => {}
        other => failures.push(format!("self-check: 97.5 must be refused, got {other:?}")),
    }
}
