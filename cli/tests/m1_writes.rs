//! Integration tests for the B4 M1 write surface — `session new` /
//! `session btw` / `session stop` / `session archive` / `session
//! restore` / `session move` / `project create` / `project list` /
//! `project delete` / `llm list` / `llm set`.
//!
//! Strategy mirrors the existing `cli_test.rs`:
//!
//! 1. Socket-backed write commands assert the cheap "Galley Core not
//!    running → exit 4 db_unavailable" path. Full happy-path coverage
//!    for these would require spinning up a real socket server in-test
//!    (no AppHandle available outside Tauri), and the underlying trait
//!    method behaviour is already covered by `core/tests/db_writes_test`
//!    and `core/tests/db_test.rs`. The atomicity invariant for
//!    `session.new` (sub-plan O1) is similarly covered by the three
//!    `tx_*` tests in `db_writes_test.rs` — those exercise
//!    `create_session_in_tx` + `send_message_in_tx` + commit/rollback
//!    directly. The integration layer's job here is to prove the CLI
//!    surface reaches the socket and reports the right exit code; the
//!    handler logic doesn't need re-testing through the binary.
//!
//! 2. Direct-SQLite read commands (`project list`, `llm list`) get
//!    full happy / empty / shape-error coverage because they don't
//!    need a server.

use std::path::PathBuf;
use std::process::{Command, Stdio};

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::SqlitePool;
use tempfile::TempDir;

const MIG_001: &str = include_str!("../../core/migrations/001_init.sql");
const MIG_002: &str = include_str!("../../core/migrations/002_add_has_unread.sql");
const MIG_003: &str = include_str!("../../core/migrations/003_add_message_summary.sql");
const MIG_004: &str = include_str!("../../core/migrations/004_add_messages_fts.sql");
const MIG_005: &str = include_str!("../../core/migrations/005_add_message_preamble.sql");
const MIG_006: &str = include_str!("../../core/migrations/006_messages_origin.sql");
const MIG_007: &str = include_str!("../../core/migrations/007_sessions_origin.sql");

async fn seeded_db_at(path: &std::path::Path) -> SqlitePool {
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    let pool = SqlitePool::connect_with(opts).await.expect("open db");
    for sql in [
        MIG_001, MIG_002, MIG_003, MIG_004, MIG_005, MIG_006, MIG_007,
    ] {
        sqlx::raw_sql(sql)
            .execute(&pool)
            .await
            .expect("run migration");
    }
    pool
}

async fn seed_project(pool: &SqlitePool, id: &str, name: &str, ts: &str) {
    sqlx::query(
        "INSERT INTO projects (id, name, pinned, last_activity_at, created_at, updated_at) \
         VALUES (?, ?, 0, ?, ?, ?)",
    )
    .bind(id)
    .bind(name)
    .bind(ts)
    .bind(ts)
    .bind(ts)
    .execute(pool)
    .await
    .expect("seed project");
}

async fn seed_pref(pool: &SqlitePool, key: &str, value_json: &str) {
    // `updated_at` is NOT NULL per migration 001 — use a fixed ts so
    // tests are deterministic.
    sqlx::query("INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?)")
        .bind(key)
        .bind(value_json)
        .bind("2026-05-20T00:00:00Z")
        .execute(pool)
        .await
        .expect("seed pref");
}

/// Run the CLI with the socket path namespaced to a tempdir, so no live
/// Galley Core on the developer's machine accidentally answers the
/// "no Core running" tests.
fn run_galley_isolated(
    db: &std::path::Path,
    tmp: &std::path::Path,
    args: &[&str],
) -> (String, Option<i32>) {
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_galley"));
    let out = Command::new(&bin)
        .args(args)
        .env("GALLEY_DB_PATH", db)
        .env("TMPDIR", tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn galley");
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    (stdout, out.status.code())
}

fn tempdir() -> TempDir {
    tempfile::Builder::new()
        .prefix("galley-m1-test-")
        .tempdir()
        .expect("create tempdir")
}

// ---------------- session.* write commands (socket) ----------------

#[tokio::test]
async fn session_new_without_core_exits_4() {
    let td = tempdir();
    let db = td.path().join("test.db");
    drop(seeded_db_at(&db).await);
    let (stdout, code) =
        run_galley_isolated(&db, td.path(), &["session", "new", "first task"]);
    assert_eq!(code, Some(4), "stdout: {stdout}");
    let parsed: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("json");
    assert_eq!(parsed["error"], "db_unavailable");
}

#[tokio::test]
async fn session_new_passes_through_optional_flags() {
    // Same exit-4 path as above, but verifies clap accepts the full
    // flag set without parser errors. If clap rejected an arg the CLI
    // would exit 2 + emit a parser error, not exit 4.
    let td = tempdir();
    let db = td.path().join("test.db");
    drop(seeded_db_at(&db).await);
    let (stdout, code) = run_galley_isolated(
        &db,
        td.path(),
        &[
            "session",
            "new",
            "investigate",
            "--project",
            "proj_demo",
            "--llm",
            "glm-4.5-x",
            "--supervisor",
            "ga-claude-1",
            "--reason",
            "weekly review",
        ],
    );
    assert_eq!(code, Some(4), "stdout: {stdout}");
}

#[tokio::test]
async fn session_btw_without_core_exits_4() {
    let td = tempdir();
    let db = td.path().join("test.db");
    drop(seeded_db_at(&db).await);
    let (stdout, code) = run_galley_isolated(
        &db,
        td.path(),
        &["session", "btw", "sess_x", "ping?"],
    );
    assert_eq!(code, Some(4), "stdout: {stdout}");
}

#[tokio::test]
async fn session_stop_without_core_exits_4() {
    let td = tempdir();
    let db = td.path().join("test.db");
    drop(seeded_db_at(&db).await);
    let (stdout, code) =
        run_galley_isolated(&db, td.path(), &["session", "stop", "sess_x"]);
    assert_eq!(code, Some(4), "stdout: {stdout}");
}

#[tokio::test]
async fn session_archive_without_core_exits_4() {
    let td = tempdir();
    let db = td.path().join("test.db");
    drop(seeded_db_at(&db).await);
    let (stdout, code) =
        run_galley_isolated(&db, td.path(), &["session", "archive", "sess_x"]);
    assert_eq!(code, Some(4), "stdout: {stdout}");
}

#[tokio::test]
async fn session_restore_without_core_exits_4() {
    let td = tempdir();
    let db = td.path().join("test.db");
    drop(seeded_db_at(&db).await);
    let (stdout, code) =
        run_galley_isolated(&db, td.path(), &["session", "restore", "sess_x"]);
    assert_eq!(code, Some(4), "stdout: {stdout}");
}

#[tokio::test]
async fn session_move_accepts_no_to_flag() {
    // `session move <id>` without `--to` is the "detach" form per
    // sub-plan O3 — the CLI must accept it and reach the socket
    // (where it'd be processed). Asserting exit 4 proves clap
    // didn't reject the omitted flag.
    let td = tempdir();
    let db = td.path().join("test.db");
    drop(seeded_db_at(&db).await);
    let (stdout, code) =
        run_galley_isolated(&db, td.path(), &["session", "move", "sess_x"]);
    assert_eq!(code, Some(4), "stdout: {stdout}");
}

#[tokio::test]
async fn session_move_accepts_to_flag() {
    let td = tempdir();
    let db = td.path().join("test.db");
    drop(seeded_db_at(&db).await);
    let (stdout, code) = run_galley_isolated(
        &db,
        td.path(),
        &["session", "move", "sess_x", "--to", "proj_demo"],
    );
    assert_eq!(code, Some(4), "stdout: {stdout}");
}

// ---------------- project.* (mixed: socket writes + SQLite reads) ----------------

#[tokio::test]
async fn project_create_without_core_exits_4() {
    let td = tempdir();
    let db = td.path().join("test.db");
    drop(seeded_db_at(&db).await);
    let (stdout, code) = run_galley_isolated(
        &db,
        td.path(),
        &["project", "create", "MyApp refactor", "--root-path", "/x"],
    );
    assert_eq!(code, Some(4), "stdout: {stdout}");
}

#[tokio::test]
async fn project_delete_without_core_exits_4() {
    let td = tempdir();
    let db = td.path().join("test.db");
    drop(seeded_db_at(&db).await);
    let (stdout, code) =
        run_galley_isolated(&db, td.path(), &["project", "delete", "proj_demo"]);
    assert_eq!(code, Some(4), "stdout: {stdout}");
}

#[tokio::test]
async fn project_list_happy_path_ndjson() {
    let td = tempdir();
    let db = td.path().join("test.db");
    let pool = seeded_db_at(&db).await;
    seed_project(&pool, "proj_a", "Alpha", "2026-05-15T00:00:00Z").await;
    seed_project(&pool, "proj_b", "Beta", "2026-05-18T00:00:00Z").await;
    drop(pool);

    let (stdout, code) = run_galley_isolated(&db, td.path(), &["project", "list"]);
    assert_eq!(code, Some(0), "stdout: {stdout}");
    let lines: Vec<&str> = stdout.trim().lines().collect();
    assert_eq!(lines.len(), 2);
    // Sort order: pinned DESC, last_activity_at DESC. Neither is pinned,
    // so most-recently-active first.
    let first: serde_json::Value =
        serde_json::from_str(lines[0]).expect("ndjson line 1");
    assert_eq!(first["id"], "proj_b");
}

#[tokio::test]
async fn project_list_empty_db_returns_empty_stdout() {
    let td = tempdir();
    let db = td.path().join("test.db");
    drop(seeded_db_at(&db).await);
    let (stdout, code) = run_galley_isolated(&db, td.path(), &["project", "list"]);
    assert_eq!(code, Some(0), "stdout: {stdout}");
    assert!(stdout.trim().is_empty(), "expected empty stdout, got: {stdout}");
}

#[tokio::test]
async fn project_list_db_unavailable_exits_4() {
    let td = tempdir();
    // Don't create the DB file. `project list` opens SqliteGalley
    // directly (no socket), so a missing file surfaces as exit 4.
    let db = td.path().join("nonexistent.db");
    let (stdout, code) = run_galley_isolated(&db, td.path(), &["project", "list"]);
    assert_eq!(code, Some(4), "stdout: {stdout}");
    let parsed: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("json");
    assert_eq!(parsed["error"], "db_unavailable");
}

// ---------------- llm.* (mixed: SQLite reads + socket writes) ----------------

#[tokio::test]
async fn llm_list_happy_path_ndjson() {
    let td = tempdir();
    let db = td.path().join("test.db");
    let pool = seeded_db_at(&db).await;
    // Cache shape mirrors what hydrate.ts seeds: array of {index, name}.
    seed_pref(
        &pool,
        "llm_list",
        r#"[{"index":0,"name":"glm-4.5-x"},{"index":1,"name":"claude-opus-4-7"}]"#,
    )
    .await;
    drop(pool);

    let (stdout, code) = run_galley_isolated(&db, td.path(), &["llm", "list"]);
    assert_eq!(code, Some(0), "stdout: {stdout}");
    let lines: Vec<&str> = stdout.trim().lines().collect();
    assert_eq!(lines.len(), 2);
    let first: serde_json::Value =
        serde_json::from_str(lines[0]).expect("ndjson line 1");
    assert_eq!(first["index"], 0);
    assert_eq!(first["name"], "glm-4.5-x");
}

#[tokio::test]
async fn llm_list_empty_cache_returns_empty_stdout_exit_0() {
    // Cache miss is the documented "open the GUI once to warm up"
    // path — must return exit 0 with empty stdout, not an error.
    let td = tempdir();
    let db = td.path().join("test.db");
    drop(seeded_db_at(&db).await);
    let (stdout, code) = run_galley_isolated(&db, td.path(), &["llm", "list"]);
    assert_eq!(code, Some(0), "stdout: {stdout}");
    assert!(stdout.trim().is_empty(), "expected empty stdout, got: {stdout}");
}

#[tokio::test]
async fn llm_list_corrupt_cache_shape_exits_2() {
    // GUI's llm_list pref is always an array. If a future GUI rev
    // shipped a different shape, the CLI should surface that loudly
    // (exit 2) so SOPs can flag the schema drift instead of silently
    // truncating output.
    let td = tempdir();
    let db = td.path().join("test.db");
    let pool = seeded_db_at(&db).await;
    seed_pref(&pool, "llm_list", r#"{"oops":"not an array"}"#).await;
    drop(pool);

    let (stdout, code) = run_galley_isolated(&db, td.path(), &["llm", "list"]);
    assert_eq!(code, Some(2), "stdout: {stdout}");
    let parsed: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("json");
    assert_eq!(parsed["error"], "invalid_args");
}

#[tokio::test]
async fn llm_set_without_core_exits_4() {
    let td = tempdir();
    let db = td.path().join("test.db");
    drop(seeded_db_at(&db).await);
    let (stdout, code) = run_galley_isolated(
        &db,
        td.path(),
        &["llm", "set", "sess_x", "glm-4.5-x"],
    );
    assert_eq!(code, Some(4), "stdout: {stdout}");
}
