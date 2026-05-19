# Galley Agent API

The contract between **Galley** and any agent that drives it via the
`galley` CLI binary or the Unix-socket / named-pipe local transport.

> **Status: B2 in-progress.** B1's six read commands plus B2's
> `session send` / `session watch` write commands are wired and
> tested. Remaining write commands (`create-session`, `archive-session`,
> `btw`, project/LLM CRUD) land in subsequent B-phases under
> `schema_version: 1`. See [refactor playbook](./refactor/README.md)
> for the rollout schedule.

## 1 · Stability

The CLI output schema **and the socket wire format** are both part of
Galley's public contract — supervisor agents and Skills depend on
them. We commit to the rules in
[CLAUDE.md "Galley 架构原则 §2 CLI surface 是公开契约面"](../CLAUDE.md).

- **`schemaVersion: 1` is additive-only.** New optional fields can
  arrive on requests and responses; existing field names and semantics
  do not change inside this major version.
- **Breaking change requires a bump.** A `schemaVersion: 2` introduces
  the breaking change, and old SOPs can opt into the v1 view via
  `--schema=1` on the CLI (or the request's `schemaVersion` field over
  the socket).
- **Exit-code categories are stable.** The five exit codes in §3 do not
  get reassigned across `schemaVersion` bumps — agents can branch on
  them confidently without parsing JSON.
- **Error discriminants are stable.** The `error` field values listed
  in §2A (socket) and §6 (CLI) are stable identifiers, not renames.
  Additions are non-breaking; renames or removals require a bump.
- **The socket path is stable.** Per-user Unix socket / named pipe
  paths in §2A don't change across `schemaVersion: 1` patch releases.

If a future change feels load-bearing enough to risk these promises, it
gets a `schemaVersion` bump.

## 2 · Where to find things

- **Database location.** The CLI reads the same SQLite file the Galley
  GUI writes to. Default paths:
  - macOS: `~/Library/Application Support/app.galley/workbench.db`
  - Linux: `$XDG_DATA_HOME/app.galley/workbench.db` or
    `~/.local/share/app.galley/workbench.db`
  - Windows: `%APPDATA%/app.galley/workbench.db`
- **Override.** Set `GALLEY_DB_PATH=<absolute-path>` to point at a
  specific file (snapshots, isolated test fixtures, etc.).
- **Identifier.** `app.galley` is the Tauri bundle identifier — do not
  change without a coordinated migration (see
  [CLAUDE.md "Tauri Identifier 不可随意改"](../CLAUDE.md)).

## 2A · Transports

Galley CLI commands reach Galley Core through one of two transports
depending on whether the command is read-only or writes state.

### Read-only commands → direct SQLite

`sessions list / search`, `session brief / show`, `status`, `health`,
`version` open the SQLite file directly via `GALLEY_DB_PATH` (or the
platform default path in §2). **No daemon required.** Useful when:

- Galley GUI isn't running but the agent wants to inspect history
- A CI / cron job wants to scrape session state from a snapshot DB

These commands return the same JSON whether or not Galley Core is
running — they don't talk to it.

### Write commands → local socket

`session send`, `session watch`, and all future B-phase write commands
connect to a per-user local socket served by a running Galley Core
process:

- **macOS / Linux**: Unix domain socket at `$TMPDIR/galley-$UID.sock`
  (typically `/tmp/galley-501.sock`). Permission `0600` — only the
  owning OS user can connect.
- **Windows**: Named pipe at `\\.\pipe\galley-$USERNAME`, scoped to
  the calling user's namespace.

**No TCP, no token, no TLS.** Auth = filesystem permission (Unix) /
user-scoped namespace (Windows). Cross-machine access goes through
GA's IM frontends + Galley CLI on the host machine, not directly to
this socket. See [CLAUDE.md "Galley 架构原则 #1 Localhost only"](../CLAUDE.md).

#### Wire format (NDJSON)

Every request is a single JSON object on one line; the server replies
with one JSON line for unary commands, or a stream of NDJSON lines for
subscription commands like `session watch`.

Request:

```json
{
  "command": "session.send",
  "args": { /* command-specific */ },
  "schemaVersion": 1,
  "requestId": "any-client-string-for-demux"
}
```

Unary response (success):

```json
{
  "ok": true,
  "requestId": "...",
  "result": { /* command-specific */ }
}
```

Unary response (error):

```json
{
  "ok": false,
  "requestId": "...",
  "error": "not_found",
  "message": "human-readable explanation"
}
```

Stream response (for subscription commands):

```json
{"stream": "event", "requestId": "...", "data": { /* event payload */ }}
{"stream": "event", "requestId": "...", "data": { /* ... */ }}
{"stream": "end",   "requestId": "...", "reason": "subprocess_exited"}
```

#### Wire-level error discriminants

These are stable identifiers — agents pattern-match on them:

| `error`            | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `invalid_args`     | Argument validation failed (missing field, bad JSON)                 |
| `not_found`        | Target resource missing (no session with that id, etc.)              |
| `db_unavailable`   | DB file missing / unopenable / Galley Core not running               |
| `unknown_command`  | Server doesn't know that command name                                |
| `schema_mismatch`  | Client's `schemaVersion` != server's accepted version                |
| `not_implemented`  | Command name reserved but no handler wired (transitional state)     |
| `idle_timeout`     | Connection sat idle past 90s — server politely closed                |
| `internal`         | Unexpected server failure                                            |

The CLI maps each tag onto the §3 exit code table when surfacing the
error.

#### Race detection at startup

If a second Galley Core process tries to start while another is
already bound to the same socket path, it logs a diagnostic and
returns without binding (so the first instance keeps owning the
socket). Stale sockets from crashed previous processes get unlinked
and rebound automatically.

A sub-millisecond race window exists between try-connect and rebind;
in practice it's never been hit. If it does happen, the second
instance exits its socket setup and CLI clients see `exit 4` until
the user restarts.

## 3 · Exit codes

| Code | Category          | When                                                        |
| ---- | ----------------- | ----------------------------------------------------------- |
| `0`  | success           | command completed; output (if any) is on stdout             |
| `1`  | `internal`        | unexpected failure (sqlx bug, FS race, etc.)                |
| `2`  | `invalid_args`    | argument validation failed (unknown `--status` value, …)    |
| `3`  | `not_found`       | requested resource missing (`session brief <id>` no row)    |
| `4`  | `db_unavailable`  | DB file missing / unopenable / corrupted                    |

Exit codes are reserved categories — they do not get reassigned. A new
error class would take the next free code (`5`, `6`, …) without
disturbing `1–4`.

## 4 · Output discipline

- **Success → JSON on stdout.** List-returning commands emit **NDJSON**
  (one object per line) so streaming parsers like `jq -c` work without
  buffering.
- **Errors → JSON on stdout.** Same stream as success, with the
  envelope in §6. Exit code carries the category for SOPs that don't
  want to parse JSON.
- **stderr is reserved.** Only Rust runtime panics / backtraces show up
  there. Safe to pipe `2>/dev/null` when you only care about the
  protocol output.
- **No colour codes / TTY frills.** Output is byte-identical whether
  attached to a TTY or piped.

## 5 · Commands

### 5.1 · `galley version`

Returns the CLI version + the schema version of its output protocol.

```bash
$ galley version
{"galley_version":"0.1.0-dev","schema_version":1}
```

Response fields:

| Field            | Type   | Notes                                              |
| ---------------- | ------ | -------------------------------------------------- |
| `galley_version` | string | semver of the `galley` binary itself               |
| `schema_version` | int    | this document's stability key (1 in B1)            |

### 5.2 · `galley sessions list [--project=X] [--status=Y] [--archived | --all]`

Lists sessions in `pinned DESC, last_activity_at DESC` order. NDJSON,
one `SessionBrief` per line.

| Flag         | Type   | Default      | Notes                                                                                             |
| ------------ | ------ | ------------ | ------------------------------------------------------------------------------------------------- |
| `--project`  | string | (unset)      | restrict to one project id                                                                        |
| `--status`   | string | (unset)      | one of `idle / connecting / running / waiting_approval / error / completed / cancelled / archived` |
| `--archived` | bool   | false        | return only archived sessions                                                                     |
| `--all`      | bool   | false        | include archived alongside active (overrides `--archived`)                                        |

Default behaviour: exclude archived (matches GUI sidebar default).

Example:

```bash
$ galley sessions list --project=proj_demo
{"id":"s-abc","title":"first chat","status":"idle","turnCount":3,"lastActivityAt":"…","createdAt":"…","updatedAt":"…","pinned":false,"hasUnread":false}
{"id":"s-def","title":"second chat","status":"completed","turnCount":12,"lastActivityAt":"…","createdAt":"…","updatedAt":"…","pinned":false,"hasUnread":false}
```

`SessionBrief` fields:

| Field             | Type            | Notes                                                                              |
| ----------------- | --------------- | ---------------------------------------------------------------------------------- |
| `id`              | string          | session identifier (treat as opaque)                                               |
| `projectId`       | string?         | project membership (absent when ungrouped)                                         |
| `title`           | string          | derived from the first user message                                                |
| `status`          | string enum     | one of the values listed under `--status` above                                    |
| `summary`         | string?         | one-line agent-supplied digest of the last turn                                    |
| `turnCount`       | int?            | number of user-message turns so far                                                |
| `lastActivityAt`  | string (ISO8601)| max(timestamps across messages + lifecycle events)                                 |
| `createdAt`       | string (ISO8601)| session creation                                                                   |
| `updatedAt`       | string (ISO8601)| last metadata write                                                                |
| `pinned`          | bool?           | sidebar pin                                                                        |
| `hasUnread`       | bool?           | new content arrived while session was not the active one (GUI signal; B2+ writes)  |

### 5.3 · `galley sessions search <query> [--all]`

FTS5 trigram search over message bodies. Two-character queries fall
back to LIKE substring search. Queries shorter than two characters
return empty.

| Flag     | Default | Notes                                  |
| -------- | ------- | -------------------------------------- |
| `--all`  | false   | include archived sessions in the scan  |

Example:

```bash
$ galley sessions search "ndjson"
{"sessionId":"s-abc","messageId":"m1","snippet":"… emit <mark>ndjson</mark> on stdout …","rank":-1.234}
```

`SearchHit` fields:

| Field        | Type   | Notes                                                                          |
| ------------ | ------ | ------------------------------------------------------------------------------ |
| `sessionId`  | string | the session containing the hit                                                 |
| `messageId`  | string | the matching message id                                                        |
| `snippet`    | string | excerpt with matches wrapped in `<mark>…</mark>`; HTML-safe                    |
| `rank`       | float  | FTS5 BM25 score (lower = better). `0.0` when the LIKE fallback returned the hit |

### 5.4 · `galley session brief <id>`

One `SessionBrief` for the given id, or exit `3 not_found`.

```bash
$ galley session brief s-abc
{"id":"s-abc","title":"…","status":"idle", …}

$ galley session brief sess_missing ; echo "exit: $?"
{"error":"not_found","detail":{"message":"session sess_missing not found"}}
exit: 3
```

### 5.5 · `galley session show <id> [--tail=N]`

Conversation messages for a session, oldest first. NDJSON, one
`MessageBrief` per line.

| Flag     | Default          | Notes                                              |
| -------- | ---------------- | -------------------------------------------------- |
| `--tail` | (full transcript)| return only the last `N` messages (still ordered)  |

`MessageBrief` fields:

| Field         | Type            | Notes                                                                 |
| ------------- | --------------- | --------------------------------------------------------------------- |
| `id`          | string          | message identifier                                                    |
| `sessionId`   | string          | parent session id                                                     |
| `role`        | string enum     | `user / agent / system`. `tool` rows surface as `agent`               |
| `content`     | string          | raw markdown body                                                     |
| `createdAt`   | string (ISO8601)|                                                                       |
| `summary`     | string?         | agent-supplied one-line digest of this turn (assistant rows only)     |
| `turnIndex`   | int?            | which user-message-turn this message belongs to                       |
| `origin`      | `Origin`?       | source of this message (B2+; omitted on rows from before migration 006) |

### 5.5a · `galley session send <id> "<content>" [--supervisor=<x>] [--reason=<y>]`

**Write command** — persists a user message into a session and dispatches
it to the live runner subprocess. Requires Galley Core to be running
(exit `4 db_unavailable` if the socket isn't reachable).

| Flag           | Default                                  | Notes                                                                |
| -------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `--supervisor` | (none → `origin.via = cli`)              | Supervisor label. When set, `origin.via` upgrades to `supervisor`.   |
| `--reason`     | (none)                                   | Free-text rationale. Stored on `messages.origin_note`; appears in audit views. |

```bash
$ galley session send sess_abc "summarize the last turn" \
    --supervisor=ga-claude-1 --reason="user said tldr"
{"message":{"id":"msg_…","sessionId":"sess_abc","role":"user","content":"summarize the last turn", \
"createdAt":"2026-05-19T…","turnIndex":3,"origin":{"via":"supervisor","supervisor":"ga-claude-1","reason":"user said tldr"}}, \
"dispatch":"dispatched"}
```

Response shape:

| Field      | Type          | Notes                                                                             |
| ---------- | ------------- | --------------------------------------------------------------------------------- |
| `message`  | `MessageBrief`| The persisted row, including server-assigned `id` + `createdAt`                   |
| `dispatch` | string enum   | `"dispatched"` if the runner received the command on stdin; `"persisted_only"` if no runner is alive (LRU-evicted / crashed / never spawned) — the row is in SQLite either way |

**Semantics**: fire-and-forget. The CLI returns as soon as the message
is persisted; it does **not** wait for the runner to complete the
agent turn. Pair with `galley session watch <id>` if you need to see
the resulting events. See [B2 playbook running note N34] for the
rationale.

**Origin handling**: if you pass `--supervisor`, the stored
`origin.via` is `supervisor`. Without it, it's `cli`. Use
`--supervisor` for SOP-driven invocations so audit logs can filter by
agent identity.

Exit codes: `0` success / `3 not_found` (session missing) /
`2 invalid_args` (session archived, malformed args) /
`4 db_unavailable` (Galley Core not running).

### 5.5b · `galley session watch <id>`

**Subscription command** — streams live IPC events from a session's
runner subprocess on stdout (one event per line, NDJSON). The
connection stays open until either:

- the subprocess exits (server sends `{"stream":"end","reason":"subprocess_exited"}` then closes), or
- the client sends SIGINT (Ctrl-C) / the process exits

Requires Galley Core to be running and a live runner for the target
session.

```bash
$ galley session watch sess_abc
{"stream":"event","requestId":null,"data":{"kind":"turn_start","sessionId":"sess_abc",…}}
{"stream":"event","requestId":null,"data":{"kind":"tool_call_start",…}}
{"stream":"event","requestId":null,"data":{"kind":"tool_call_end",…}}
{"stream":"event","requestId":null,"data":{"kind":"turn_end",…}}
{"stream":"end","requestId":null,"reason":"subprocess_exited"}
$ # exit 0
```

The `data` payload mirrors the runner ↔ Galley Core IPC event shape
defined in [`docs/ipc-protocol.md`](./ipc-protocol.md) §4 — same
`kind` discriminator and per-event field set.

**No backlog support yet.** Subscribers see events from subscribe-time
forward only. Catching up on the recent history requires
`galley session show <id> --tail=N` first. A `--from=<event-index>`
flag is planned (see [B2 playbook running note N35]).

Exit codes: `0` clean stream end / `3 not_found` (no live runner for
that session id) / `4 db_unavailable` (Galley Core not running).

### 5.6 · `galley status`

Aggregate counts.

```bash
$ galley status
{"total":7,"running":0,"waitingInput":0,"errored":0}
```

`StatusSummary` fields:

| Field           | Type | Notes                                                                                              |
| --------------- | ---- | -------------------------------------------------------------------------------------------------- |
| `total`         | int  | non-archived sessions                                                                              |
| `running`       | int  | sessions in `running` status. Note: B1 surfaces persistence-truth — these counts will usually read as 0 unless caught mid-write, since GUI only persists `archived / completed / cancelled` (transient runtime status coerced to `idle` on save). Real runtime counts arrive in B2+ via the Rust-owned runner manager. |
| `waitingInput`  | int  | sessions with `waiting_approval` status (same persistence caveat)                                  |
| `errored`       | int  | sessions in `error` status (same caveat)                                                           |

### 5.7 · `galley health`

Health probe. B1 ships a partial set — filesystem / SQLite-checkable
rows are real; Python-dependent rows (`agentmain_import`,
`llm_session_init`) report `deferred_b4` until B4 daemon mode ships.

```bash
$ galley health
{"checks":[
  {"id":"db_readable","status":"ok","detail":"/Users/.../workbench.db"},
  {"id":"ga_path","status":"ok","detail":"/Users/.../GenericAgent"},
  {"id":"mykey_py","status":"ok","detail":"/Users/.../mykey.py"},
  {"id":"agentmain_import","status":"deferred_b4","detail":"requires runner spawn — see B4 daemon"},
  {"id":"llm_session_init","status":"deferred_b4","detail":"requires runner spawn — see B4 daemon"}
]}
```

`HealthReport` fields:

| Field    | Type                 | Notes                                  |
| -------- | -------------------- | -------------------------------------- |
| `checks` | `HealthCheck[]`      | one entry per probe                    |

`HealthCheck` fields:

| Field    | Type        | Notes                                                                                                    |
| -------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `id`     | string      | stable identifier (pattern-match on this, not the `detail` text)                                         |
| `status` | string enum | `ok / warn / fail / deferred_b4`                                                                         |
| `detail` | string?     | human-readable explanation (paths, error messages, deferral reasoning)                                   |

Probe id catalogue (will grow):

| `id`                | Cover                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `db_readable`       | `SELECT 1` against the resolved DB path                                                              |
| `ga_path`           | `prefs.ga_config.gaPath` is set + the path resolves to a directory                                   |
| `mykey_py`          | gated on `ga_path`; checks `<ga_path>/mykey.py` is a file                                            |
| `agentmain_import`  | B4 — `python -c "import agentmain"` against the bundled / user Python                                |
| `llm_session_init`  | B4 — instantiate one LLM session, capture the API-key resolution error if any                        |

Pattern: agents should branch on the `status` value (`ok` / `warn` /
`fail` actionable; `deferred_b4` indicates "Galley can't currently check
this — trust other signals or wait for B4").

## 6 · Error envelope

### CLI (read-only commands, direct SQLite)

Every error — across every read command — uses this shape on stdout:

```json
{
  "error":  "not_found" | "invalid_args" | "db_unavailable" | "internal",
  "detail": {
    "message": "<human-readable explanation>"
  }
}
```

- `error` is a stable discriminant (matches the `GalleyError` enum
  variants in [`core/src/error.rs`](../core/src/error.rs)).
- `detail` is an object so we can grow it additively in v1
  (`session_id`, `path`, `expected`, etc.) without breaking parsers
  that already pattern-match on `error`.

### CLI (write commands, socket transport)

Write commands surface server-side errors with the same `error` /
`message` fields the socket wire format uses (§2A) — the CLI maps
them onto exit codes via the §3 table and prints the same JSON to
stdout. Example:

```bash
$ galley session send sess_missing "hi" ; echo "exit: $?"
{"ok":false,"requestId":null,"error":"not_found","message":"session 'sess_missing' does not exist"}
exit: 3
```

Future error classes get their own discriminant; v1 will not rename
existing ones.

## 6A · Shared types

### `Origin`

Records the source of a write. Required on every write command;
optional on read responses (older rows from before migration 006
omit it).

| Field         | Type            | Notes                                                                  |
| ------------- | --------------- | ---------------------------------------------------------------------- |
| `via`         | string enum     | `gui` / `cli` / `supervisor` / `system`. Matches the SQL CHECK constraint on `messages.created_via` and `sessions.created_via` |
| `supervisor`  | string?         | Supervisor label / agent identity (e.g. `"ga-claude-1"`). Required when `via=supervisor`; optional with `via=cli` |
| `reason`      | string?         | Free-text rationale. Shows up in audit / activity-log views            |

Wire example:

```json
{"via": "supervisor", "supervisor": "ga-claude-1", "reason": "user said tldr"}
```

## 7 · Versioning

Inside `schemaVersion: 1`:

- Adding a new command, flag, or output field is **non-breaking**.
- Adding a new value to a string enum (status, error, health status,
  …) is **non-breaking** — agents must handle unknown values
  gracefully (default branch).
- Adding a new error discriminant on the socket transport (e.g. a new
  not-yet-known cause for `not_implemented`) is **non-breaking**.
- Removing or renaming a command / flag / field / enum value is
  **breaking**. Don't.

Inside a future `schemaVersion: 2`:

- A breaking change can ship.
- Both the CLI (`--schema=1`) and the socket (`schemaVersion` in the
  request) will support opting back into the v1 view; old SOPs keep
  working until they choose to migrate.

`galley version` returns the schema version the CLI binary is willing
to speak. The socket `version` command returns the server's accepted
schema version. Future binaries that speak multiple versions will
expose this as an array.

## 8 · Planned (future B-phases)

The following are intentionally **not in `schema_version: 1` CLI surface
yet** — mentioned here so SOPs can plan their integration shape.

- `galley session create [--project=X] [--title=…]` — start a new
  session from the CLI.
- `galley session archive <id>` — persist `status=archived` + clear
  `has_unread`.
- `galley session btw <id> <text>` — out-of-band system message
  injected mid-stream (no agent loop trigger).
- `galley session watch <id> --from=<event-index>` — backlog/resume
  support for supervisors reconnecting after a network blip.
- `galley project create | rename | delete` — project CRUD.
- `galley llm list | switch` — per-session LLM selection.

All future write commands will accept `--supervisor=<x>` /
`--reason=<y>` flags following the same Origin convention `session send`
uses today (§5.5a). Read commands stay flag-light.

### 8A · `GalleyApi` trait surface (B3 M4a)

The session/project CRUD methods landed in B3 M4a as Rust trait + Tauri
invoke commands, but **not** as CLI subcommands. They are the
authoritative write path the GUI routes through in B3 M4b; B4 will mint
the matching `galley session ...` / `galley project ...` CLI surface.

SOPs writing against the socket transport directly today can call them
as JSON-RPC-style commands once B4 socket dispatch lands. The trait
signatures (Rust types):

| Method | Args | Returns |
|---|---|---|
| `create_session` | `CreateSessionInput`, `Origin` | `SessionBrief` |
| `archive_session` | `SessionId`, `Origin` | `SessionBrief` |
| `unarchive_session` | `SessionId`, `Origin` | `SessionBrief` |
| `rename_session` | `SessionId`, `title: String`, `Origin` | `SessionBrief` |
| `set_session_pinned` | `SessionId`, `pinned: bool`, `Origin` | `SessionBrief` |
| `delete_session` | `SessionId`, `Origin` | `()` |
| `assign_session_to_project` | `SessionId`, `Option<String>`, `Origin` | `SessionBrief` |
| `set_session_llm` | `SessionId`, `index: Option<u32>`, `display_name: Option<String>` | `SessionBrief` |
| `bump_session_after_turn` | `SessionId`, `Option<String>`, `Option<u32>`, `mark_unread: bool` | `SessionBrief` |
| `clear_session_unread` | `SessionId` | `()` |
| `bulk_archive_sessions` | `Vec<SessionId>`, `Origin` | `u32` |
| `bulk_unarchive_sessions` | `Vec<SessionId>`, `Origin` | `u32` |
| `bulk_delete_sessions` | `Vec<SessionId>`, `Origin` | `u32` |
| `list_projects` | — | `Vec<ProjectBrief>` |
| `create_project` | `CreateProjectInput`, `Origin` | `ProjectBrief` |
| `update_project` | `ProjectId`, `ProjectPatch`, `Origin` | `ProjectBrief` |
| `delete_project` | `ProjectId`, `Origin` | `()` |

Input types (camelCase on the JSON wire):

- `CreateSessionInput { id, title, projectId?, selectedLlmIndex?, selectedLlmDisplayName? }`
  — `id` is caller-assigned (`s-<base36>-<rand>` convention; conflicts
  surface as `invalid_args`).
- `CreateProjectInput { id, name, rootPath?, icon?, color? }` —
  same id-assigned-by-caller convention (`proj_<random16>`).
- `ProjectPatch { name?, rootPath??, icon??, color??, pinned? }` —
  the `?` (Option) means "leave the column alone"; the `??`
  (double-Option) on `rootPath` / `icon` / `color` means
  `Some(None)` clears the column to SQL NULL while `Some(Some(v))`
  writes `v`.

Error categories (all map to the §3 exit codes):

- `not_found` — session or project id doesn't exist.
- `invalid_args` — empty title / name after trim, id conflict, archived
  session pin attempt, FK violation (project_id pointing at nothing).
- `db_unavailable` — DB pool can't open.

### Transport notes

For the **transport**: the read commands' direct-SQLite path is a B1
convenience kept for "Galley Core not running" scenarios (snapshot
inspection, CI). The write commands' socket path is the eventual
canonical path for everything; B4 may consolidate read commands onto
it too once daemon mode is the dogfood baseline.

## 9 · See also

- [PRD §11 Agent / CLI surface](./PRD.md) — design rationale.
- [IPC protocol](./ipc-protocol.md) — wire format for the runner ↔
  Galley Core stdin/stdout channel + the socket transport this
  document layers on top.
- [B1 playbook](./refactor/B1-rust-core.md) — read-command rollout.
- [B2 playbook](./refactor/B2-bridge-ownership.md) — socket + write
  command rollout (M3-M5 already shipped; M6/M7 in progress).
- [Refactor invariants](./refactor/invariants.md) — including §I5
  (API surface single source of truth) which makes this CLI's output
  the same source as the Tauri-invoke output the GUI sees, and §I3
  (migration numbering).
- Source for the trait + Origin type:
  [`core/src/api.rs`](../core/src/api.rs) /
  [`core/src/api/origin.rs`](../core/src/api/origin.rs).
