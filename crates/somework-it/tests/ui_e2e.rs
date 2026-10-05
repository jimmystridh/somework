//! Runs the Playwright suite (`e2e/`) against the seeded devstack. Opt-in because it needs Node, a Chromium
//! build and a few minutes: `SOMEWORK_E2E=1 cargo test -p somework-it --test ui_e2e -- --nocapture`.

use std::{path::PathBuf, process::Command};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repo root")
}

#[test]
fn operations_console_passes_the_playwright_suite() {
    if std::env::var("SOMEWORK_E2E").as_deref() != Ok("1") {
        eprintln!("skipped: set SOMEWORK_E2E=1 to run the browser suite");
        return;
    }
    let e2e = repo_root().join("e2e");
    if !e2e.join("node_modules").exists() {
        let install = Command::new("npm").args(["install", "--no-audit", "--no-fund"]).current_dir(&e2e).status().expect("npm install");
        assert!(install.success(), "npm install failed");
    }
    let status = Command::new("npx").args(["playwright", "test"]).current_dir(&e2e).status().expect("run playwright");
    assert!(status.success(), "Playwright suite failed; see e2e/playwright-report and e2e/test-results");
}
