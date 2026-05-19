//! Integration tests for `SqliteGalley` reads.
//!
//! Tests use an in-memory SQLite DB seeded with the same migration SQL
//! the GUI runs in production. Each test sets up its own DB to keep
//! cases isolated.

use galley_core_lib::api::{GalleyApi, SearchScope, SessionFilter, SessionId, SessionStatus};
use galley_core_lib::db::SqliteGalley;
use sqlx::SqlitePool;

// Migration SQL — same files Tauri's tauri-plugin-sql runs in
// production via core/src/lib.rs's `run()`. Included by relative path
// from `core/tests/`. Each migration is idempotent only at the schema
// level: re-running on an existing DB would fail, but we always start
// from a fresh in-memory pool per test.
const MIG_001: &str = include_str!("../migrations/001_init.sql");
const MIG_002: &str = include_str!("../migrations/002_add_has_unread.sql");
const MIG_003: &str = include_str!("../migrations/003_add_message_summary.sql");
const MIG_004: &str = include_str!("../migrations/004_add_messages_fts.sql");
const MIG_005: &str = include_str!("../migrations/005_add_message_preamble.sql");
const MIG_006: &str = include_str!("../migrations/006_messages_origin.sql");
const MIG_007: &str = include_str!("../migrations/007_sessions_origin.sql");

async fn fresh_pool() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:")
        .await
        .expect("open in-memory sqlite");
    for sql in [MIG_001, MIG_002, MIG_003, MIG_004, MIG_005, MIG_006, MIG_007] {
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

async fn seed_message(
    pool: &SqlitePool,
    id: &str,
    session_id: &str,
    turn: i64,
    seq: i64,
    role: &str,
    content: &str,
    created_at: &str,
) {
    sqlx::query(
        "INSERT INTO messages (id, session_id, turn_index, sequence, role, content, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(session_id)
    .bind(turn)
    .bind(seq)
    .bind(role)
    .bind(content)
    .bind(created_at)
    .execute(pool)
    .await
    .expect("seed message");

    // Mirror the GUI's `indexMessageFts` write so FTS5 search hits
    // the row. Only user.content and assistant.final_answer are
    // indexed in production — but for test simplicity index any
    // role's content. The trigram tokenizer doesn't care.
    sqlx::query(
        "INSERT INTO messages_fts (message_id, session_id, role, turn_index, body) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(session_id)
    .bind(role)
    .bind(turn)
    .bind(content)
    .execute(pool)
    .await
    .expect("seed fts row");
}

#[tokio::test]
async fn list_sessions_default_filter_returns_all_in_recency_order() {
    let pool = fresh_pool().await;
    seed_session(&pool, "sess_old", "old", "idle", "2026-05-10T00:00:00Z").await;
    seed_session(&pool, "sess_new", "new", "idle", "2026-05-18T00:00:00Z").await;
    seed_session(&pool, "sess_arch", "old archived", "archived", "2026-05-15T00:00:00Z").await;

    let galley = SqliteGalley::from_pool(pool);
    // Default SessionFilter has archived=None → no filter (active +
    // archived both returned). Matches the legacy `loadSessions()`
    // TS behaviour the GUI hydrate path depends on.
    let rows = galley
        .list_sessions(SessionFilter::default())
        .await
        .expect("list_sessions");

    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec!["sess_new", "sess_arch", "sess_old"]);
}

#[tokio::test]
async fn list_sessions_archived_false_excludes_archived() {
    let pool = fresh_pool().await;
    seed_session(&pool, "sess_old", "old", "idle", "2026-05-10T00:00:00Z").await;
    seed_session(&pool, "sess_new", "new", "idle", "2026-05-18T00:00:00Z").await;
    seed_session(&pool, "sess_arch", "archived", "archived", "2026-05-15T00:00:00Z").await;

    let galley = SqliteGalley::from_pool(pool);
    let rows = galley
        .list_sessions(SessionFilter {
            archived: Some(false),
            ..Default::default()
        })
        .await
        .expect("list_sessions excluding archived");

    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec!["sess_new", "sess_old"]);
}

#[tokio::test]
async fn list_sessions_with_archived_true_returns_only_archived() {
    let pool = fresh_pool().await;
    seed_session(&pool, "sess_live", "live", "idle", "2026-05-18T00:00:00Z").await;
    seed_session(&pool, "sess_arch", "archived", "archived", "2026-05-10T00:00:00Z").await;

    let galley = SqliteGalley::from_pool(pool);
    let rows = galley
        .list_sessions(SessionFilter {
            archived: Some(true),
            ..Default::default()
        })
        .await
        .expect("list archived");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id.as_str(), "sess_arch");
    assert!(matches!(rows[0].status, SessionStatus::Archived));
}

#[tokio::test]
async fn list_sessions_status_filter_matches_exact() {
    let pool = fresh_pool().await;
    seed_session(&pool, "sess_a", "a", "idle", "2026-05-18T00:00:00Z").await;
    seed_session(&pool, "sess_b", "b", "completed", "2026-05-17T00:00:00Z").await;

    let galley = SqliteGalley::from_pool(pool);
    let rows = galley
        .list_sessions(SessionFilter {
            status: Some(SessionStatus::Completed),
            ..Default::default()
        })
        .await
        .expect("list completed");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id.as_str(), "sess_b");
}

#[tokio::test]
async fn session_brief_not_found_errors() {
    let pool = fresh_pool().await;
    let galley = SqliteGalley::from_pool(pool);
    let err = galley
        .session_brief(SessionId("sess_missing".into()))
        .await
        .expect_err("expected NotFound");
    match err {
        galley_core_lib::error::GalleyError::NotFound { .. } => {}
        other => panic!("expected NotFound, got {other:?}"),
    }
}

#[tokio::test]
async fn session_brief_returns_one_row() {
    let pool = fresh_pool().await;
    seed_session(&pool, "sess_x", "Hello", "idle", "2026-05-18T00:00:00Z").await;
    let galley = SqliteGalley::from_pool(pool);
    let brief = galley
        .session_brief(SessionId("sess_x".into()))
        .await
        .expect("session_brief");
    assert_eq!(brief.title, "Hello");
    assert!(matches!(brief.status, SessionStatus::Idle));
    assert_eq!(brief.pinned, Some(false));
}

#[tokio::test]
async fn session_messages_returns_chronological_order() {
    let pool = fresh_pool().await;
    seed_session(&pool, "sess_x", "Conv", "idle", "2026-05-18T00:00:00Z").await;
    seed_message(&pool, "m1", "sess_x", 1, 0, "user", "hi", "2026-05-18T00:00:00Z").await;
    seed_message(&pool, "m2", "sess_x", 1, 1, "assistant", "hello", "2026-05-18T00:00:01Z").await;
    seed_message(&pool, "m3", "sess_x", 2, 0, "user", "how?", "2026-05-18T00:00:02Z").await;

    let galley = SqliteGalley::from_pool(pool);
    let msgs = galley
        .session_messages(SessionId("sess_x".into()), None)
        .await
        .expect("session_messages");
    let ids: Vec<&str> = msgs.iter().map(|m| m.id.0.as_str()).collect();
    assert_eq!(ids, vec!["m1", "m2", "m3"]);
}

#[tokio::test]
async fn session_messages_tail_returns_last_n_in_order() {
    let pool = fresh_pool().await;
    seed_session(&pool, "sess_x", "Conv", "idle", "2026-05-18T00:00:00Z").await;
    for i in 1..=5 {
        seed_message(
            &pool,
            &format!("m{i}"),
            "sess_x",
            i,
            0,
            "user",
            &format!("msg{i}"),
            &format!("2026-05-18T00:00:0{i}Z"),
        )
        .await;
    }

    let galley = SqliteGalley::from_pool(pool);
    let msgs = galley
        .session_messages(SessionId("sess_x".into()), Some(2))
        .await
        .expect("session_messages tail");
    let ids: Vec<&str> = msgs.iter().map(|m| m.id.0.as_str()).collect();
    assert_eq!(ids, vec!["m4", "m5"]);
}

#[tokio::test]
async fn search_messages_short_query_returns_empty() {
    let pool = fresh_pool().await;
    seed_session(&pool, "sess_x", "x", "idle", "2026-05-18T00:00:00Z").await;
    seed_message(&pool, "m1", "sess_x", 1, 0, "user", "anything", "2026-05-18T00:00:00Z").await;

    let galley = SqliteGalley::from_pool(pool);
    assert!(galley
        .search_messages("a".into(), SearchScope::default())
        .await
        .expect("search 1-char")
        .is_empty());
}

#[tokio::test]
async fn search_messages_fts_finds_hit() {
    let pool = fresh_pool().await;
    seed_session(&pool, "sess_x", "x", "idle", "2026-05-18T00:00:00Z").await;
    seed_message(
        &pool,
        "m1",
        "sess_x",
        1,
        0,
        "user",
        "the quick brown fox",
        "2026-05-18T00:00:00Z",
    )
    .await;
    seed_message(
        &pool,
        "m2",
        "sess_x",
        2,
        0,
        "user",
        "elephants are slow",
        "2026-05-18T00:00:01Z",
    )
    .await;

    let galley = SqliteGalley::from_pool(pool);
    let hits = galley
        .search_messages("quick".into(), SearchScope::default())
        .await
        .expect("search");

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].message_id.0, "m1");
    // snippet wraps the hit token in <mark>…</mark>.
    assert!(hits[0].snippet.contains("<mark>"));
}

#[tokio::test]
async fn search_messages_active_scope_excludes_archived() {
    let pool = fresh_pool().await;
    seed_session(&pool, "sess_live", "live", "idle", "2026-05-18T00:00:00Z").await;
    seed_session(&pool, "sess_arch", "archived", "archived", "2026-05-15T00:00:00Z").await;
    seed_message(&pool, "m1", "sess_live", 1, 0, "user", "needle", "2026-05-18T00:00:00Z").await;
    seed_message(&pool, "m2", "sess_arch", 1, 0, "user", "needle", "2026-05-15T00:00:00Z").await;

    let galley = SqliteGalley::from_pool(pool);
    let active_hits = galley
        .search_messages("needle".into(), SearchScope::Active)
        .await
        .expect("search active");
    assert_eq!(active_hits.len(), 1);
    assert_eq!(active_hits[0].message_id.0, "m1");

    let all_hits = galley
        .search_messages("needle".into(), SearchScope::All)
        .await
        .expect("search all");
    assert_eq!(all_hits.len(), 2);
}

#[tokio::test]
async fn status_counts_non_archived_sessions() {
    let pool = fresh_pool().await;
    seed_session(&pool, "a", "a", "idle", "2026-05-18T00:00:00Z").await;
    seed_session(&pool, "b", "b", "running", "2026-05-18T00:00:01Z").await;
    seed_session(&pool, "c", "c", "completed", "2026-05-18T00:00:02Z").await;
    seed_session(&pool, "d", "d", "archived", "2026-05-18T00:00:03Z").await;

    let galley = SqliteGalley::from_pool(pool);
    let s = galley.status().await.expect("status");
    assert_eq!(s.total, 3);
    assert_eq!(s.running, 1);
    assert_eq!(s.waiting_input, 0);
    assert_eq!(s.errored, 0);
}

#[tokio::test]
async fn health_reports_db_readable_and_deferred_probes() {
    let pool = fresh_pool().await;
    let galley = SqliteGalley::from_pool(pool);
    let report = galley.health().await.expect("health");
    // 5 check ids, exact list depends on env. Just assert presence
    // of the SQLite-checkable ones + deferred B4 markers.
    let ids: Vec<&str> = report.checks.iter().map(|c| c.id.as_str()).collect();
    assert!(ids.contains(&"db_readable"));
    assert!(ids.contains(&"ga_path"));
    assert!(ids.contains(&"mykey_py"));
    assert!(ids.contains(&"agentmain_import"));
    assert!(ids.contains(&"llm_session_init"));
}
