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
    check_float_round_trip(failures);
    check_key_order(failures);
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

/// Decimal literals whose nearest double is one or two units in the last place away from what serde_json reads
/// without its `float_roundtrip` feature, with the bits JSON.parse gives each. A reader that rounds differently from
/// JSON.parse would judge a corpus number against another value than the TypeScript loader does.
const ROUND_TRIP_LITERALS: [(&str, u64); 3] = [
    ("2.601815908301661318609e-23", 0x3b3f_743a_efa7_9b47),
    ("5.6321223307924402685995e30", 0x4651_c597_9992_5db8),
    ("1.0928159013962459e-7", 0x3e7d_55c6_10a1_9ad1),
];

fn check_float_round_trip(failures: &mut Vec<String>) {
    for (literal, bits) in ROUND_TRIP_LITERALS {
        match serde_json::from_str::<Value>(literal) {
            Ok(value) => match value.as_f64() {
                Some(number) if number.to_bits() == bits => {}
                other => failures.push(format!(
                    "self-check: {literal} must read as the double with bits {bits:016x}, got {other:?}"
                )),
            },
            Err(error) => failures.push(format!("self-check: {literal} did not parse: {error}")),
        }
    }
}

/// The deepest nesting of objects and arrays a corpus file may have, which every loader enforces at this value: it is
/// below the recursion limit of the JSON parsers the loaders read through, so a file past it is refused the same way by
/// all of them.
const MAX_DEPTH: usize = 64;

/// One level of nesting while the text is scanned: an array, or an object with the last key it held, as UTF-16 code
/// units, and whether the next string in it is a key.
enum Frame {
    Array,
    Object {
        expect_key: bool,
        last: Option<Vec<u16>>,
    },
}

/// The code units of the string literal that starts at `start` (a double quote), and the index just past it. An
/// escape other than `\u` stands for one character; a `\u` escape stands for the code unit it names, so a lone
/// surrogate stays one. `None` for a literal this scan cannot decode, which the JSON parser refuses as well.
fn read_string_literal(text: &str, start: usize) -> Option<(Vec<u16>, usize)> {
    let mut units = Vec::new();
    let mut index = start + 1;
    loop {
        let character = text.get(index..)?.chars().next()?;
        match character {
            '"' => return Some((units, index + 1)),
            '\\' => {
                let escape = text.get(index + 1..)?.chars().next()?;
                if escape == 'u' {
                    units.push(u16::from_str_radix(text.get(index + 2..index + 6)?, 16).ok()?);
                    index += 6;
                } else {
                    units.push(match escape {
                        'b' => 0x08,
                        'f' => 0x0c,
                        'n' => 0x0a,
                        'r' => 0x0d,
                        't' => 0x09,
                        other => u16::try_from(u32::from(other)).ok()?,
                    });
                    index += 1 + escape.len_utf8();
                }
            }
            other => {
                let mut buffer = [0u16; 2];
                units.extend_from_slice(other.encode_utf16(&mut buffer));
                index += other.len_utf8();
            }
        }
    }
}

/// The first problem with the order of the keys in a corpus file's own text, which no parsed value can show: within
/// every object the keys are in UTF-16 code unit order, each after the one before and none repeated, so integer-like
/// keys are ordered as the strings they are, and a key holding an unpaired surrogate is refused, since no loader reads
/// it the same way. The TypeScript loader applies the same rule.
pub fn key_order_problem(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut stack: Vec<Frame> = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                let Some((units, end)) = read_string_literal(text, index) else {
                    return Some("a string literal cannot be read".to_owned());
                };
                if let Some(Frame::Object { expect_key, last }) = stack.last_mut()
                    && *expect_key
                {
                    if char::decode_utf16(units.iter().copied()).any(|unit| unit.is_err()) {
                        return Some("a key holds an unpaired surrogate".to_owned());
                    }
                    if last.as_ref().is_some_and(|before| units <= *before) {
                        return Some(format!(
                            "key {:?} is not after the key before it: keys are in UTF-16 code unit order without repeats",
                            String::from_utf16_lossy(&units)
                        ));
                    }
                    *last = Some(units);
                    *expect_key = false;
                }
                index = end;
                continue;
            }
            opening @ (b'{' | b'[') => {
                stack.push(if opening == b'{' {
                    Frame::Object {
                        expect_key: true,
                        last: None,
                    }
                } else {
                    Frame::Array
                });
                if stack.len() > MAX_DEPTH {
                    return Some(format!("nesting is deeper than the maximum of {MAX_DEPTH}"));
                }
            }
            b'}' | b']' => {
                stack.pop();
            }
            b',' => {
                if let Some(Frame::Object { expect_key, .. }) = stack.last_mut() {
                    *expect_key = true;
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn check_key_order(failures: &mut Vec<String>) {
    let accepted = [
        r#"{"a":1,"b":{"10":1,"9":2},"c":[{"x":1,"y":2}]}"#,
        r#"{"\ud83d\ude00":1,"\ue000":2}"#,
        r#"{"a":"{\"z\":1,\"b\":2}","b":1}"#,
    ];
    let refused = [
        r#"{"b":1,"a":2}"#,
        r#"{"a":1,"a":2}"#,
        r#"{"9":1,"10":2}"#,
        r#"{"\ue000":1,"\ud83d\ude00":2}"#,
        r#"{"\ud800":1}"#,
    ];
    let too_deep = "[".repeat(MAX_DEPTH + 1);
    let deepest = "[".repeat(MAX_DEPTH) + &"]".repeat(MAX_DEPTH);
    for text in accepted {
        if let Some(problem) = key_order_problem(text) {
            failures.push(format!(
                "self-check: {text} must be in order, got {problem}"
            ));
        }
    }
    if key_order_problem(&deepest).is_some() {
        failures.push("self-check: nesting at the maximum depth must be accepted".to_owned());
    }
    if key_order_problem(&too_deep).is_none() {
        failures.push("self-check: nesting past the maximum depth must be refused".to_owned());
    }
    for text in refused {
        if key_order_problem(text).is_none() {
            failures.push(format!("self-check: {text} must be refused"));
        }
    }
}
