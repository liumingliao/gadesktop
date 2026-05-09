use tauri_plugin_sql::{Migration, MigrationKind};

/// SQLite filename. Resolved by tauri-plugin-sql relative to the
/// platform's app-data directory:
///
///   macOS:  ~/Library/Application Support/app.gaworkbench/
///
/// Schema lives in src-tauri/migrations/001_init.sql; tauri-plugin-sql
/// runs Up migrations in version order on first connect.
const DB_URL: &str = "sqlite:workbench.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "initial schema",
        sql: include_str!("../migrations/001_init.sql"),
        kind: MigrationKind::Up,
    }];

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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
