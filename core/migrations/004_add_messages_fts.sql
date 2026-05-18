-- 004_add_messages_fts.sql · GA Workbench v0.1
-- Full-text search index over message bodies. Powers the
-- CommandPalette "Matches in conversations" section so the user
-- can find old turns by content, not just session title.
--
-- Tokenizer choice: `trigram` (SQLite 3.34+). Works for English +
-- Chinese + mixed without needing a dedicated CJK segmenter — every
-- 3-character substring of indexed text becomes a token, and MATCH
-- queries with phrases of length >= 3 find the substring directly.
-- For 2-char queries we fall back to LIKE in the application layer
-- (lib/db.ts `searchMessages`); for 0-1 chars we don't search.
--
-- This is a *standalone* FTS5 table (not external-content) keyed
-- by message_id. App-level writes maintain it on every message
-- insert/update via lib/db.ts `indexMessageFts`. No triggers, so
-- the index stays inspectable and disposable — backfill on hydrate
-- (lib/db.ts `backfillFtsIfEmpty`) reconstructs from `messages` any
-- time the row count drifts.
--
-- Indexed columns:
--   body  — user.content or assistant.final_answer (the markdown
--           the user actually reads). Excluding assistant.content
--           keeps raw <thinking> blocks out of search hits.
--
-- UNINDEXED columns:
--   message_id  — primary lookup back to `messages.id`
--   session_id  — used by JOIN to sessions and to attribute hits
--   role        — for rendering "user" vs "agent" badge on hits
--   turn_index  — useful when V2 wants "jump to this turn"

CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_id UNINDEXED,
  session_id UNINDEXED,
  role UNINDEXED,
  turn_index UNINDEXED,
  body,
  tokenize = 'trigram case_sensitive 0'
);
