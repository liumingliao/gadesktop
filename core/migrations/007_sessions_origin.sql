-- 007_sessions_origin.sql · B2 M5
--
-- Origin fields on sessions. Mirrors the messages origin model
-- (006_messages_origin.sql) but for the session itself: when a
-- supervisor / CLI creates a brand-new session (M4 introduces this
-- capability), we record who and why.
--
-- The naming differs slightly from messages because "supervisor" /
-- "origin_note" without a `created_by_` prefix on a session would be
-- ambiguous — sessions also have a "last touched by supervisor" concept
-- in v0.5 that's separate from "originally created by supervisor".
-- Explicit prefixes future-proof the schema.

ALTER TABLE sessions ADD COLUMN created_via TEXT NOT NULL DEFAULT 'gui'
  CHECK (created_via IN ('gui', 'cli', 'supervisor', 'system'));

ALTER TABLE sessions ADD COLUMN created_by_supervisor TEXT;
ALTER TABLE sessions ADD COLUMN created_origin_note TEXT;
