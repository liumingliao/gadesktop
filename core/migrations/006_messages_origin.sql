-- 006_messages_origin.sql · B2 M5
--
-- Origin fields on messages. From v0.5 a Galley session can receive
-- messages from multiple frontends (GUI, CLI, Supervisor SOPs). The
-- origin triple `(created_via, supervisor, origin_note)` tells later
-- consumers where a given message came from + the reason an external
-- caller cited when sending it.
--
-- Additive only — old rows backfill to `gui` (the only frontend that
-- existed before this migration).
--
-- Per [docs/refactor/invariants.md §I3], v0.5 migrations use numbers
-- 006-029. v0.1 used 001-005. This is number 006 (the first under the
-- B2 range).

ALTER TABLE messages ADD COLUMN created_via TEXT NOT NULL DEFAULT 'gui'
  CHECK (created_via IN ('gui', 'cli', 'supervisor', 'system'));

ALTER TABLE messages ADD COLUMN supervisor TEXT;
ALTER TABLE messages ADD COLUMN origin_note TEXT;

-- Index for "show me everything supervisor X has injected into this session"
-- queries — the Galley v0.5 UI surfaces a supervisor activity log per session
-- (PRD §15). Until that UI ships, agents can run the same query via
-- `galley session show <id> --origin=supervisor:foo`.
CREATE INDEX messages_by_supervisor
  ON messages(session_id, supervisor)
  WHERE supervisor IS NOT NULL;
