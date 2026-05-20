//! Galley CLI discovery file writer.
//!
//! Supervisor agents (GA bots, Claude Skills, user-written orchestrators)
//! need to find the `galley` CLI binary's absolute path to drive Galley.
//! Hard-coding paths is brittle: bundle layouts shift between releases,
//! dev vs production paths differ, Windows installs end up in
//! `%ProgramFiles%` vs `%LOCALAPPDATA%` depending on installer choice.
//!
//! Galley's contract (PRD §12.2, agent-api.md §2A, supervisor SOP §1):
//! the GUI writes the absolute CLI binary path into a fixed per-user
//! file once at startup. SOPs `cat` that file, parse line 1, invoke the
//! resulting absolute path.
//!
//! ## Path
//!
//! - macOS / Linux: `~/.config/galley/cli-path`
//!   (XDG_CONFIG_HOME overrides `~/.config` if set, per the spec)
//! - Windows: `%APPDATA%\galley\cli-path`
//!
//! ## File format
//!
//! Two-line plain text, LF newlines:
//!
//! ```text
//! /absolute/path/to/galley
//! schema_version=1
//! ```
//!
//! Line 1 = the absolute path. Line 2 = the discovery file schema version
//! so we can evolve the format additively (line 3+ in v2 etc.) without
//! confusing v1 SOPs that only read line 1.
//!
//! ## Idempotency
//!
//! If the file already contains the exact same content, we skip the
//! write entirely. This keeps the mtime stable across app restarts —
//! file watchers (some IM bots tail the discovery file to detect Galley
//! upgrades) don't get spurious notifications when nothing actually
//! changed.
//!
//! ## Non-fatal failure
//!
//! Discovery file write failures are **non-fatal**. Galley itself works
//! fine without it — only supervisor SOPs need it. If the CLI binary
//! can't be located (likely in a not-yet-bundled dev build), or the
//! config dir can't be created (permission issues), we log and move on.
//! The user sees Galley start normally; SOPs see "discovery file not
//! found, ask user to upgrade" per the supervisor SOP §1 fallback.

use std::path::{Path, PathBuf};

/// Current schema version of the discovery file format.
const SCHEMA_VERSION: u32 = 1;

/// Filename inside the per-user config directory. Stable v1 contract.
const FILENAME: &str = "cli-path";

/// Subdir under the platform config root.
const APP_SUBDIR: &str = "galley";

/// The binary name to look for next to Galley Core's `current_exe`.
/// In dev: `target/debug/galley`. In a future bundled .app:
/// `Galley.app/Contents/MacOS/galley` (requires Tauri `externalBin`
/// config — not yet shipped at v0.5 alpha; tracked as M3 follow-up).
#[cfg(not(target_os = "windows"))]
const CLI_BIN_NAME: &str = "galley";
#[cfg(target_os = "windows")]
const CLI_BIN_NAME: &str = "galley.exe";

/// Outcome of a discovery write attempt. Used by the setup-hook caller
/// for logging only — Galley starts regardless of which branch we
/// landed on.
#[derive(Debug)]
pub enum DiscoveryOutcome {
    /// File was created or updated to the new content.
    Written { path: PathBuf, cli_path: PathBuf },
    /// File already contained the exact same content; we left it alone
    /// to keep mtime stable for upstream watchers.
    NoOp { path: PathBuf },
    /// Couldn't find the CLI binary next to `current_exe`. Most likely
    /// a dev build where `cargo build -p galley-cli` hasn't run yet,
    /// or a not-yet-bundled production app. The setup hook surfaces
    /// this as a warning so the user knows SOPs will fail discovery.
    CliBinaryNotFound { searched: PathBuf },
    /// Couldn't resolve the platform config dir (e.g. `HOME` unset on
    /// a stripped-down container, `APPDATA` missing on Windows).
    ConfigDirUnresolvable { reason: String },
    /// Couldn't create the config subdir.
    MkdirFailed {
        path: PathBuf,
        reason: String,
    },
    /// Couldn't write the file itself (permission denied, disk full).
    WriteFailed {
        path: PathBuf,
        reason: String,
    },
}

/// Resolve the absolute path of the `galley` CLI binary next to
/// `current_exe`. Returns `None` if the sibling doesn't exist.
///
/// **Rationale**: `current_exe()` in Tauri returns Galley Core's main
/// binary path (`galley-core` in dev, `Galley` in production after the
/// productName rename). The CLI is a sibling in both layouts:
///   - dev: `target/debug/{galley-core, galley}`
///   - bundled (future): `Galley.app/Contents/MacOS/{Galley, galley}`
///
/// Until externalBin bundling lands, production .app won't have the
/// sibling — we surface that as `CliBinaryNotFound` so the dogfood log
/// flags it clearly.
fn locate_cli_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let parent = exe.parent()?;
    let candidate = parent.join(CLI_BIN_NAME);
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

/// Resolve the platform config-root directory.
///
/// - macOS / Linux: `$XDG_CONFIG_HOME` if set, else `$HOME/.config`.
///   This matches the supervisor SOP's documented read path and the
///   XDG Base Directory Spec (which Linux respects + macOS treats as a
///   convention). We deliberately don't follow Apple's
///   `~/Library/Application Support` here — the agent-api contract
///   names `~/.config/galley/cli-path` literally; macOS-on-CLI tools
///   universally honour `~/.config` (homebrew, git, gh, etc.).
/// - Windows: `%APPDATA%`. No XDG analogue.
fn config_root() -> Result<PathBuf, String> {
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            if !xdg.is_empty() {
                return Ok(PathBuf::from(xdg));
            }
        }
        let home = std::env::var("HOME").map_err(|_| {
            "HOME environment variable is not set".to_string()
        })?;
        Ok(PathBuf::from(home).join(".config"))
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").map_err(|_| {
            "APPDATA environment variable is not set".to_string()
        })?;
        Ok(PathBuf::from(appdata))
    }
}

/// Compose the v1 file body. Stable contract: line 1 is the absolute
/// CLI path; line 2 is `schema_version=<u32>`. Trailing LF per POSIX
/// text file convention. UTF-8.
fn compose_body(cli_path: &Path) -> String {
    format!(
        "{}\nschema_version={}\n",
        cli_path.display(),
        SCHEMA_VERSION,
    )
}

/// Write the discovery file. See module-level docs for semantics.
///
/// Returns the outcome enum so the caller can log appropriately — the
/// function itself never fails fatally.
pub fn write_discovery_file() -> DiscoveryOutcome {
    let Some(cli_path) = locate_cli_binary() else {
        let searched = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|p| p.join(CLI_BIN_NAME)))
            .unwrap_or_else(|| PathBuf::from("<current_exe unresolvable>"));
        return DiscoveryOutcome::CliBinaryNotFound { searched };
    };

    let root = match config_root() {
        Ok(r) => r,
        Err(reason) => return DiscoveryOutcome::ConfigDirUnresolvable { reason },
    };
    let dir = root.join(APP_SUBDIR);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return DiscoveryOutcome::MkdirFailed {
            path: dir,
            reason: e.to_string(),
        };
    }

    let file_path = dir.join(FILENAME);
    let new_body = compose_body(&cli_path);

    // Idempotency check: read existing and compare. Bytes-exact match
    // → no-op. Anything else (different path, different schema, file
    // doesn't exist, partial write last time) → rewrite.
    if let Ok(existing) = std::fs::read_to_string(&file_path) {
        if existing == new_body {
            return DiscoveryOutcome::NoOp { path: file_path };
        }
    }

    if let Err(e) = std::fs::write(&file_path, &new_body) {
        return DiscoveryOutcome::WriteFailed {
            path: file_path,
            reason: e.to_string(),
        };
    }

    DiscoveryOutcome::Written {
        path: file_path,
        cli_path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::TempDir;

    // Env-var manipulation isn't thread-safe; serialize the tests that
    // touch HOME / XDG_CONFIG_HOME / APPDATA. Lock for the duration of
    // each affected test.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn compose_body_includes_path_and_schema() {
        let body = compose_body(Path::new("/some/path/galley"));
        assert_eq!(body, "/some/path/galley\nschema_version=1\n");
    }

    #[test]
    fn config_root_uses_xdg_when_set() {
        let _guard = ENV_LOCK.lock().unwrap();
        #[cfg(not(target_os = "windows"))]
        {
            let td = TempDir::new().expect("tempdir");
            let prev = std::env::var("XDG_CONFIG_HOME").ok();
            std::env::set_var("XDG_CONFIG_HOME", td.path());
            let root = config_root().expect("resolve");
            assert_eq!(root, td.path());
            // Restore env
            match prev {
                Some(v) => std::env::set_var("XDG_CONFIG_HOME", v),
                None => std::env::remove_var("XDG_CONFIG_HOME"),
            }
        }
        #[cfg(target_os = "windows")]
        {
            // Skip on Windows — XDG not honored there.
            let _ = TempDir::new();
        }
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn config_root_falls_back_to_home_dot_config() {
        let _guard = ENV_LOCK.lock().unwrap();
        let td = TempDir::new().expect("tempdir");
        let prev_xdg = std::env::var("XDG_CONFIG_HOME").ok();
        let prev_home = std::env::var("HOME").ok();
        std::env::remove_var("XDG_CONFIG_HOME");
        std::env::set_var("HOME", td.path());
        let root = config_root().expect("resolve");
        assert_eq!(root, td.path().join(".config"));
        match prev_xdg {
            Some(v) => std::env::set_var("XDG_CONFIG_HOME", v),
            None => std::env::remove_var("XDG_CONFIG_HOME"),
        }
        match prev_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }
}
