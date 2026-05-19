//! Integration tests for the `galley` CLI binary.
//!
//! Each test:
//!   1. Builds a fresh on-disk SQLite file in a tempdir (in-memory pools
//!      can't be shared between processes, so a file is required).
//!   2. Seeds rows via direct sqlx writes (matches core/tests/db_test.rs
//!      style — same migration SQL + seed helpers).
//!   3. Spawns `target/debug/galley <args>` with `GALLEY_DB_PATH`
//!      pointing at the temp file.
//!   4. Asserts stdout / exit code.
//!
//! Tests share `tokio` (for the setup helper) but the CLI binary
//! itself is invoked synchronously via `std::process::Command`.

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

/// Build a temp .db file with all migrations applied + (optionally)
/// seed rows. Returns the path; caller stashes it for the spawned
/// command via `GALLEY_DB_PATH`.
async fn seeded_db_at(path: &std::path::Path) -> SqlitePool {
    // `mode=rwc` so sqlx creates the file if missing.
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

async fn seed_session(pool: &SqlitePool, id: &str, title: &str, status: &str, ts: &str) {
    sqlx::query(
        "INSERT INTO sessions (id, title, status, turn_count, pending_approval_count, \
            error_count, pinned, last_activity_at, created_at, updated_at) \
         VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?, ?)",
    )
    .bind(id)
    .bind(title)
    .bind(status)
    .bind(ts)
    .bind(ts)
    .bind(ts)
    .execute(pool)
    .await
    .expect("seed session");
}

/// Resolve the binary path. Cargo writes test binaries to
/// `target/<profile>/deps/...` but workspace bins land at
/// `target/<profile>/<name>`. `CARGO_BIN_EXE_galley` is set by Cargo
/// for the test-runner so we can locate the binary deterministically.
fn galley_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_galley"))
}

fn run_galley(db_path: &std::path::Path, args: &[&str]) -> (String, Option<i32>) {
    let out = Command::new(galley_bin())
        .args(args)
        .env("GALLEY_DB_PATH", db_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn galley");
    let stdout = String::from_utf8(out.stdout).expect("utf8 stdout");
    (stdout, out.status.code())
}

#[tokio::test]
async fn version_subcommand_prints_schema_v1() {
    let td = tempdir();
    let db = td.path().join("workbench.db");
    let _pool = seeded_db_at(&db).await;
    let (stdout, code) = run_galley(&db, &["version"]);
    assert_eq!(code, Some(0));
    let payload: serde_json::Value = serde_json::from_str(stdout.trim()).expect("json");
    assert_eq!(payload["schema_version"], 1);
    assert!(payload.get("galley_version").is_some());
}

#[tokio::test]
async fn sessions_list_emits_ndjson_recent_first() {
    let td = tempdir();
    let db = td.path().join("workbench.db");
    let pool = seeded_db_at(&db).await;
    seed_session(&pool, "old", "old", "idle", "2026-05-10T00:00:00Z").await;
    seed_session(&pool, "new", "new", "idle", "2026-05-18T00:00:00Z").await;
    drop(pool);

    let (stdout, code) = run_galley(&db, &["sessions", "list"]);
    assert_eq!(code, Some(0));
    let lines: Vec<&str> = stdout.trim().lines().collect();
    assert_eq!(lines.len(), 2);
    // Each line is independently valid JSON (NDJSON contract).
    let first: serde_json::Value = serde_json::from_str(lines[0]).expect("ndjson line 1");
    let second: serde_json::Value = serde_json::from_str(lines[1]).expect("ndjson line 2");
    assert_eq!(first["id"], "new");
    assert_eq!(second["id"], "old");
}

#[tokio::test]
async fn session_brief_missing_exits_3() {
    let td = tempdir();
    let db = td.path().join("workbench.db");
    let _pool = seeded_db_at(&db).await;
    let (stdout, code) = run_galley(&db, &["session", "brief", "sess_missing"]);
    assert_eq!(code, Some(3), "stdout was: {stdout}");
    let payload: serde_json::Value = serde_json::from_str(stdout.trim()).expect("json");
    assert_eq!(payload["error"], "not_found");
}

#[tokio::test]
async fn sessions_list_invalid_status_exits_2() {
    let td = tempdir();
    let db = td.path().join("workbench.db");
    let _pool = seeded_db_at(&db).await;
    let (stdout, code) = run_galley(&db, &["sessions", "list", "--status", "not_a_status"]);
    assert_eq!(code, Some(2), "stdout was: {stdout}");
    let payload: serde_json::Value = serde_json::from_str(stdout.trim()).expect("json");
    assert_eq!(payload["error"], "invalid_args");
}

#[tokio::test]
async fn db_unavailable_exits_4() {
    let td = tempdir();
    // No seeded_db_at call → file doesn't exist. `create_if_missing(false)`
    // in SqliteGalley::open() should surface as DbUnavailable / exit 4.
    let db = td.path().join("nonexistent.db");
    let (stdout, code) = run_galley(&db, &["status"]);
    assert_eq!(code, Some(4), "stdout was: {stdout}");
    let payload: serde_json::Value = serde_json::from_str(stdout.trim()).expect("json");
    assert_eq!(payload["error"], "db_unavailable");
}

#[tokio::test]
async fn status_returns_counts() {
    let td = tempdir();
    let db = td.path().join("workbench.db");
    let pool = seeded_db_at(&db).await;
    seed_session(&pool, "a", "a", "idle", "2026-05-18T00:00:00Z").await;
    seed_session(&pool, "b", "b", "completed", "2026-05-18T00:00:01Z").await;
    drop(pool);

    let (stdout, code) = run_galley(&db, &["status"]);
    assert_eq!(code, Some(0));
    let s: serde_json::Value = serde_json::from_str(stdout.trim()).expect("json");
    assert_eq!(s["total"], 2);
}

// ---- B2 M4 write command tests ----

/// `galley session send` with no Galley Core running maps to exit 4
/// (DbUnavailable per CLI exit-code contract). Asserts the CLI gracefully
/// reports the socket connect failure instead of panicking.
#[tokio::test]
async fn session_send_without_core_running_exits_4() {
    let td = tempdir();
    let db = td.path().join("test.db");
    let pool = seeded_db_at(&db).await;
    seed_session(&pool, "s1", "x", "idle", "2026-05-18T00:00:00Z").await;
    drop(pool);

    // No Galley Core process → socket file absent OR refused. Either
    // way, session send should report exit 4. We pre-empt cross-test
    // pollution by setting TMPDIR to the tempdir so any (impossible)
    // existing socket in /tmp doesn't accidentally match.
    let (stdout, code) = run_galley_with_tmpdir(
        &db,
        td.path(),
        &["session", "send", "s1", "hello"],
    );
    assert_eq!(code, Some(4), "exit code: stdout = {stdout}");
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim()).expect("json");
    assert_eq!(parsed["error"], "db_unavailable");
}

/// `galley session watch` same as above: no Core → exit 4.
#[tokio::test]
async fn session_watch_without_core_running_exits_4() {
    let td = tempdir();
    let db = td.path().join("test.db");
    let pool = seeded_db_at(&db).await;
    drop(pool);

    let (stdout, code) = run_galley_with_tmpdir(
        &db,
        td.path(),
        &["session", "watch", "s1"],
    );
    assert_eq!(code, Some(4), "exit code: stdout = {stdout}");
}

/// Variant of run_galley that also sets TMPDIR so the CLI's
/// `socket_path()` helper resolves to a tempdir-relative socket — keeps
/// these tests from accidentally picking up a real Galley Core socket
/// on the dev machine.
fn run_galley_with_tmpdir(
    db: &std::path::Path,
    tmp: &std::path::Path,
    args: &[&str],
) -> (String, Option<i32>) {
    let bin = std::path::PathBuf::from(env!("CARGO_BIN_EXE_galley"));
    let out = Command::new(&bin)
        .args(args)
        .env("GALLEY_DB_PATH", db)
        .env("TMPDIR", tmp)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn galley");
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    (stdout, out.status.code())
}

// RAII tempdir — drops the directory when the `TempDir` is dropped.
// Each test binds the value with `let _td = tempdir();` (or similar)
// so cleanup runs at the end of the test body.
fn tempdir() -> TempDir {
    tempfile::Builder::new()
        .prefix("galley-cli-test-")
        .tempdir()
        .expect("create tempdir")
}
