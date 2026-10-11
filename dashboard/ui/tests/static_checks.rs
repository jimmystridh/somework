//! Source checks for what the page must never do. Everything shown from free text (instructions, notes, skills, summaries, error text) is
//! rendered as text: Dioxus escapes it, so nothing may switch that off. The page's content policy also forbids inline styles.

use std::{fs, path::{Path, PathBuf}};

fn sources(directory: &Path, found: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).expect("the source directory is readable") {
        let path = entry.expect("a directory entry").path();
        if path.is_dir() {
            sources(&path, found);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            found.push(path);
        }
    }
}

fn all_sources() -> Vec<(PathBuf, String)> {
    let mut paths = Vec::new();
    sources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut paths);
    assert!(paths.len() > 10, "the check must see the whole UI, saw {} files", paths.len());
    paths.into_iter().map(|path| { let text = fs::read_to_string(&path).expect("a source file is readable"); (path, text) }).collect()
}

/// The numbers of the lines of `text` that contain `needle`.
fn lines_with(text: &str, needle: &str) -> Vec<usize> {
    text.lines().enumerate().filter(|(_, line)| line.contains(needle)).map(|(number, _)| number + 1).collect()
}

fn offenders(needle: &str) -> Vec<String> {
    all_sources().into_iter().flat_map(|(path, text)| lines_with(&text, needle).into_iter().map(move |number| format!("{}:{number}", path.display())).collect::<Vec<_>>()).collect()
}

#[test]
fn no_markup_is_ever_built_from_text() {
    let needle = ["dangerous", "_inner_", "html"].concat();
    assert_eq!(offenders(&needle), Vec::<String>::new(), "free text must be rendered as text, never as markup");
}

#[test]
fn nothing_writes_html_into_the_page_by_hand() {
    for needle in [["inner", "HTML"].concat(), ["document", ".write("].concat(), ["insert", "AdjacentHTML"].concat()] {
        assert_eq!(offenders(&needle), Vec::<String>::new(), "{needle}");
    }
}

#[test]
fn no_element_carries_an_inline_style() {
    for needle in [" style: ", "{ style:", ["set", "_attribute(\"style\""].concat().as_str()] {
        assert_eq!(offenders(needle), Vec::<String>::new(), "the content policy forbids inline styles: use a class of public/style.css ({needle})");
    }
}

#[test]
fn the_checks_would_notice_an_offender() {
    let needle = ["dangerous", "_inner_", "html"].concat();
    let page = format!("rsx! {{\n    div {{ class: \"ok\" }}\n    div {{ {needle}: text }}\n}}");
    assert_eq!(lines_with(&page, &needle), [3]);
    assert!(lines_with("div { class: \"ok\" }", &needle).is_empty());
}
