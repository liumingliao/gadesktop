pub mod api;
pub mod db;
pub mod error;
pub mod ipc;
pub mod runner_commands;
pub mod runner_manager;

use api::{GalleyApi, SessionBrief, SessionFilter};
use db::SqliteGalley;
use tauri_plugin_sql::{Migration, MigrationKind};

/// SQLite filename. Resolved by tauri-plugin-sql relative to the
/// platform's app-data directory:
///
///   macOS:  ~/Library/Application Support/app.gaworkbench/
///
/// Schema lives in core/migrations/001_init.sql; tauri-plugin-sql
/// runs Up migrations in version order on first connect.
const DB_URL: &str = "sqlite:workbench.db";

/// Plain `Path::exists` check that bypasses `tauri-plugin-fs`'s
/// `fs:scope` glob allow-list.
///
/// **Why a custom command exists.** v0.1.0-alpha.1 Windows users
/// reported the Onboarding health check failing on the very first row
/// ("GA 路径存在") for any GA install outside the user-profile tree —
/// e.g. `D:\projects_2026\GenericAgent`, external SSDs, `/opt/...`.
/// `tauri-plugin-fs`'s scope was set to `$HOME/**`, `$DOCUMENT/**`,
/// `$DESKTOP/**`, `$DOWNLOAD/**` (defaults inherited from Tauri's
/// sandboxed-web-content threat model); paths outside those globs
/// throw a permission error that our `fsExists` catches and reports
/// as "path does not exist", which is technically wrong and
/// operationally a dead-end (no app-visible way to widen the scope).
///
/// Galley is a trusted desktop tool: the dist is statically bundled,
/// loads no remote content, and the only paths it ever inspects come
/// from a user-driven OS picker or input box. The web-sandbox threat
/// model doesn't apply. Rather than widening `fs:scope` to `**` (and
/// inheriting glob-on-Windows quirks plus a wide write surface for
/// any future plugin-fs usage), this command exposes one narrow read
/// — boolean existence — directly from Rust, where `std::path::Path`
/// handles cross-platform separators correctly and no scope check
/// runs. JS callers route through `invoke("path_exists", ...)`
/// instead of `@tauri-apps/plugin-fs`'s `exists()`.
#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// B1 M3 read — first GalleyApi method exposed through the Tauri
/// invoke transport. Validates the end-to-end path
/// (GUI → Tauri invoke → Rust core → SQLite). Used as the migration
/// template for B2/B3 (gui/src/lib/db.ts `loadSessions` → `loadSessionsViaCore`).
///
/// Returns `(SessionBrief[])` on success and a JSON-stringified
/// [`crate::error::GalleyError`] on failure. The error shape matches
/// the CLI agent-api.md schema (B1 M5) so all transports surface the
/// same `error: <category>` discriminant.
#[tauri::command]
async fn list_sessions(filter: SessionFilter) -> std::result::Result<Vec<SessionBrief>, String> {
    let galley = SqliteGalley::open()
        .await
        .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()))?;
    galley
        .list_sessions(filter)
        .await
        .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "initial schema",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add sessions.has_unread",
            sql: include_str!("../migrations/002_add_has_unread.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add messages.summary",
            sql: include_str!("../migrations/003_add_message_summary.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add messages_fts (full-text search)",
            sql: include_str!("../migrations/004_add_messages_fts.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add messages.preamble",
            sql: include_str!("../migrations/005_add_message_preamble.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DB_URL, migrations)
                .build(),
        )
        // RunnerManager is the single Rust authority for Python runner
        // subprocesses (B2 M1). Held as Tauri app state so the
        // `spawn_runner` / `send_to_runner` / etc. commands all reach the
        // same instance. Window close + app quit must call
        // `shutdown_all_runners` from JS — there isn't a clean hook here
        // to await async cleanup before Tauri tears the runtime down.
        .manage(runner_manager::RunnerManager::new())
        .invoke_handler(tauri::generate_handler![
            path_exists,
            list_sessions,
            runner_commands::spawn_runner,
            runner_commands::send_to_runner,
            runner_commands::shutdown_runner,
            runner_commands::kill_runner,
            runner_commands::runner_stderr_tail,
            runner_commands::shutdown_all_runners,
        ])
        .setup(|_app| {
            // Windows-only custom chrome: drop native decorations and
            // restore the drop shadow via window-shadows-v2 so the borderless
            // window doesn't look like a flat rectangle. Mac keeps its
            // titleBarStyle: "Overlay" from tauri.conf.json — this block
            // is cfg-gated out at compile time on macOS, so the Mac binary
            // contains zero Windows-specific code.
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                use window_shadows_v2::set_shadows;
                let window = _app
                    .get_webview_window("main")
                    .expect("main webview window must exist at setup time");
                window
                    .set_decorations(false)
                    .expect("failed to disable native decorations on Windows");
                // window-shadows-v2 0.1.1: `set_shadows(&mut App, bool)`
                // — takes the App handle (not a window) and returns
                // unit `()`. Internally it iterates the app's windows
                // and applies DWM shadow to each.
                set_shadows(_app, true);
            }

            // macOS-only top menu bar. On macOS apps that don't install
            // a menu look "half-native" — the menu bar shows generic
            // Tauri default entries. We install a Galley-specific menu
            // that mirrors the in-app actions (Settings / New Chat /
            // Conversation Width) plus standard system items
            // (Hide / Quit / Cut / Copy / Paste / Minimize / Zoom).
            //
            // Custom menu items emit `menu:<id>` events; App.tsx
            // listens and routes them to the same store actions the
            // keyboard shortcuts already trigger. Predefined items
            // (Quit / Hide / Copy / etc.) are handled by the OS
            // directly and need no JS wiring.
            //
            // Win/Linux don't get a menu — Win uses our custom chrome
            // (decorations off, no native menu bar surface) and Linux
            // isn't a v0.2 target. Users on those platforms reach the
            // same actions through TopBar buttons / keyboard / Command
            // Palette.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{
                    AboutMetadataBuilder, MenuBuilder, MenuItemBuilder,
                    PredefinedMenuItem, SubmenuBuilder,
                };

                let about_metadata = AboutMetadataBuilder::new()
                    .name(Some("Galley"))
                    .version(Some(env!("CARGO_PKG_VERSION")))
                    .credits(Some("Made by wangjc683".to_string()))
                    .website(Some("https://github.com/wangjc683/galley".to_string()))
                    .website_label(Some("GitHub".to_string()))
                    .build();

                let app_submenu = SubmenuBuilder::new(_app, "Galley")
                    .item(&PredefinedMenuItem::about(
                        _app,
                        Some("About Galley"),
                        Some(about_metadata),
                    )?)
                    .separator()
                    .item(
                        &MenuItemBuilder::new("Settings…")
                            .id("settings")
                            .accelerator("Cmd+,")
                            .build(_app)?,
                    )
                    .separator()
                    .item(&PredefinedMenuItem::hide(_app, None)?)
                    .item(&PredefinedMenuItem::hide_others(_app, None)?)
                    .item(&PredefinedMenuItem::show_all(_app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::quit(_app, None)?)
                    .build()?;

                let file_submenu = SubmenuBuilder::new(_app, "File")
                    .item(
                        &MenuItemBuilder::new("New Chat")
                            .id("new_chat")
                            .accelerator("Cmd+N")
                            .build(_app)?,
                    )
                    .separator()
                    .item(&PredefinedMenuItem::close_window(_app, None)?)
                    .build()?;

                let edit_submenu = SubmenuBuilder::new(_app, "Edit")
                    .item(&PredefinedMenuItem::undo(_app, None)?)
                    .item(&PredefinedMenuItem::redo(_app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::cut(_app, None)?)
                    .item(&PredefinedMenuItem::copy(_app, None)?)
                    .item(&PredefinedMenuItem::paste(_app, None)?)
                    .item(&PredefinedMenuItem::select_all(_app, None)?)
                    .separator()
                    // Find: V0.2 will wire to in-conversation search.
                    // Disabled in v0.1 so the shortcut shows but click
                    // is a no-op (same treatment as Toggle Sidebar).
                    .item(
                        &MenuItemBuilder::new("Find")
                            .id("find")
                            .accelerator("Cmd+F")
                            .enabled(false)
                            .build(_app)?,
                    )
                    .build()?;

                let width_submenu = SubmenuBuilder::new(_app, "Conversation Width")
                    .item(
                        &MenuItemBuilder::new("Compact (760px)")
                            .id("width_compact")
                            .build(_app)?,
                    )
                    .item(
                        &MenuItemBuilder::new("Wide (1200px)")
                            .id("width_wide")
                            .build(_app)?,
                    )
                    .build()?;

                let view_submenu = SubmenuBuilder::new(_app, "View")
                    // Toggle Sidebar: V0.1 placeholder — wiring lands
                    // in V0.2. Disabled so the shortcut shows but click
                    // is a no-op (consistent with Find).
                    .item(
                        &MenuItemBuilder::new("Toggle Sidebar")
                            .id("toggle_sidebar")
                            .accelerator("Cmd+\\")
                            .enabled(false)
                            .build(_app)?,
                    )
                    .item(&width_submenu)
                    .build()?;

                let window_submenu = SubmenuBuilder::new(_app, "Window")
                    .item(&PredefinedMenuItem::minimize(_app, None)?)
                    .item(&PredefinedMenuItem::maximize(_app, Some("Zoom"))?)
                    .separator()
                    .item(&PredefinedMenuItem::bring_all_to_front(_app, None)?)
                    .build()?;

                let help_submenu = SubmenuBuilder::new(_app, "Help")
                    .item(
                        &MenuItemBuilder::new("Galley on GitHub")
                            .id("github")
                            .build(_app)?,
                    )
                    .item(
                        &MenuItemBuilder::new("Report a Bug")
                            .id("issues")
                            .build(_app)?,
                    )
                    .build()?;

                let menu = MenuBuilder::new(_app)
                    .item(&app_submenu)
                    .item(&file_submenu)
                    .item(&edit_submenu)
                    .item(&view_submenu)
                    .item(&window_submenu)
                    .item(&help_submenu)
                    .build()?;

                _app.set_menu(menu)?;

                _app.on_menu_event(|app, event| {
                    use tauri::Emitter;
                    use tauri_plugin_opener::OpenerExt;
                    match event.id.0.as_str() {
                        // Custom in-app actions — emit; App.tsx routes
                        // to the same store action the keyboard
                        // shortcut would trigger.
                        "settings" => {
                            let _ = app.emit("menu:settings", ());
                        }
                        "new_chat" => {
                            let _ = app.emit("menu:new_chat", ());
                        }
                        "width_compact" => {
                            let _ = app.emit("menu:width_compact", ());
                        }
                        "width_wide" => {
                            let _ = app.emit("menu:width_wide", ());
                        }
                        // External links — open in system browser
                        // server-side so we don't round-trip through
                        // JS. tauri-plugin-opener is already loaded.
                        "github" => {
                            let _ = app.opener().open_url(
                                "https://github.com/wangjc683/galley",
                                None::<&str>,
                            );
                        }
                        "issues" => {
                            let _ = app.opener().open_url(
                                "https://github.com/wangjc683/galley/issues",
                                None::<&str>,
                            );
                        }
                        // "find" and "toggle_sidebar" are disabled in
                        // v0.1; click never fires. Predefined items
                        // (quit / hide / copy / paste / undo / redo /
                        // minimize / maximize / etc.) are handled by
                        // AppKit directly and never reach this match.
                        _ => {}
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
