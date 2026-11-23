//! Writing an export to disk.
//!
//! The webview builds the bytes; this decides where they land. It is a separate
//! command rather than a filesystem plugin because the frontend has no business
//! naming an arbitrary path — see `safe_stem`, which is the only interesting
//! thing in the file.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// What the UI needs to tell the user where their data went.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    /// Full path, for revealing it in the file manager.
    pub path: String,
    /// Just the file name, which is what the confirmation should say — a full
    /// path in a 210px menu wraps to three lines and reads as an error.
    pub name: String,
}

/// The formats an export can be written in. An enum rather than a string, so a
/// caller cannot name the extension — see `safe_stem` for why that matters.
#[derive(serde::Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Json,
    Md,
    Svg,
}

impl Format {
    fn extension(self) -> &'static str {
        match self {
            Format::Json => "json",
            Format::Md => "md",
            Format::Svg => "svg",
        }
    }
}

/// Reduce a caller-supplied name to something that cannot escape the directory
/// it is being written into.
///
/// The stem comes from a project's name, which the user typed, which means it
/// can be `../../.ssh/authorized_keys` as easily as `Research`. Rejecting the
/// bad ones would be a check to keep in sync with every filesystem's idea of a
/// bad one; keeping only known-good characters is a rule that does not change
/// when someone finds a new way to spell a separator.
///
/// Alphanumerics, dash and underscore survive. Everything else — separators,
/// dots, colons, NUL, control characters, the lot — becomes a dash.
fn safe_stem(stem: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();

    // Collapse the runs the mapping above creates, and refuse a name that is
    // empty or all separators. A leading dash is dropped too: it is not a path
    // problem, but a file called `-x.json` is one many command line tools read
    // as a flag.
    let collapsed = cleaned
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    let trimmed: String = collapsed.chars().take(80).collect();

    if trimmed.is_empty() {
        "export".to_string()
    } else {
        trimmed
    }
}

/// The first free path in `dir` for this name, `name-2.json` style.
///
/// Overwriting is the wrong default for a command whose entire purpose is not
/// losing data. Two exports on the same day have the same name — the stem
/// carries a date, not a time — so this is the common case, not the edge one.
fn free_path(dir: &Path, stem: &str, extension: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{extension}"));
    if !first.exists() {
        return first;
    }
    for n in 2..1000 {
        let candidate = dir.join(format!("{stem}-{n}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // A thousand exports of the same project on the same day. Overwriting the
    // last one is a better answer than refusing to export at all.
    dir.join(format!("{stem}-{extension}-latest.{extension}"))
}

pub fn write(
    app: &AppHandle,
    stem: &str,
    format: Format,
    contents: &str,
) -> Result<Written, String> {
    // Downloads, falling back to home. Not the app's own data directory: the
    // point of the file is to be somewhere the user can find it, back it up and
    // carry it to another machine, and `~/Library/Application Support` is none
    // of those.
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("no directory to export into: {e}"))?;

    std::fs::create_dir_all(&dir).map_err(|e| format!("could not open {}: {e}", dir.display()))?;

    let path = free_path(&dir, &safe_stem(stem), format.extension());
    std::fs::write(&path, contents).map_err(|e| format!("could not write the export: {e}"))?;

    Ok(Written {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagrams_use_the_svg_extension() {
        assert_eq!(Format::Svg.extension(), "svg");
    }

    #[test]
    fn a_stem_keeps_the_characters_that_are_already_safe() {
        assert_eq!(
            safe_stem("atimo-Research-2026-07-30"),
            "atimo-Research-2026-07-30"
        );
        assert_eq!(safe_stem("a_b-C9"), "a_b-C9");
    }

    /// The whole reason this function exists. A project name is user text, and
    /// it reaches here on its way to being part of a path.
    #[test]
    fn a_stem_cannot_escape_its_directory() {
        for hostile in [
            "../../.ssh/authorized_keys",
            "..\\..\\windows\\system32",
            "/etc/passwd",
            "..",
            ".",
        ] {
            let stem = safe_stem(hostile);
            assert!(!stem.contains('/'), "{hostile} kept a separator: {stem}");
            assert!(!stem.contains('\\'), "{hostile} kept a separator: {stem}");
            assert!(!stem.contains(".."), "{hostile} kept a traversal: {stem}");
            assert!(
                !stem.starts_with('-'),
                "{hostile} starts with a dash: {stem}"
            );
        }
    }

    #[test]
    fn a_stem_survives_being_written_in_another_script() {
        // Not an edge case: the app is used in Portuguese, and "Pesquisa" with
        // an accent is an ordinary project name. It must still produce a usable
        // file name rather than an empty one.
        assert_eq!(safe_stem("Pesquisa Acadêmica"), "Pesquisa-Acad-mica");
        assert_eq!(safe_stem("研究"), "export");
    }

    #[test]
    fn a_stem_that_reduces_to_nothing_still_names_a_file() {
        assert_eq!(safe_stem(""), "export");
        assert_eq!(safe_stem("///"), "export");
        assert_eq!(safe_stem("---"), "export");
    }

    #[test]
    fn a_control_character_does_not_survive() {
        assert_eq!(safe_stem("a\0b\nc"), "a-b-c");
    }

    #[test]
    fn a_second_export_on_the_same_day_does_not_overwrite_the_first() {
        let dir = tempdir();
        let first = free_path(&dir, "notes", "json");
        std::fs::write(&first, "one").unwrap();

        let second = free_path(&dir, "notes", "json");
        assert_ne!(first, second);
        assert_eq!(second.file_name().unwrap(), "notes-2.json");

        // And the first is still there, which is the point.
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "one");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("atimo-export-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
