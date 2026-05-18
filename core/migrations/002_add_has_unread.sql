-- 002_add_has_unread.sql · GA Workbench v0.1
-- Add per-session unread flag (Stage 3 dev-verify round 7).
--
-- has_unread is set when a turn_end IPC event arrives for a session
-- that is NOT the active one, and cleared when the user activates
-- that session via the sidebar. Together with the existing run
-- status (running / idle / error), this gives the sidebar a three-
-- way display:
--   running                        →  spinner (already obvious)
--   idle  + has_unread = 1         →  static icon + brand dot + bold title
--   idle  + has_unread = 0         →  static icon
--
-- Stored as INTEGER (0/1) for SQLite, mapped to boolean in TS.
-- DEFAULT 0 so existing rows from the v1 schema flip to "read" on
-- upgrade — fair starting state since there's no way to retroactively
-- know whether the user has seen prior turns.

ALTER TABLE sessions ADD COLUMN has_unread INTEGER NOT NULL DEFAULT 0;
