/**
 * App cold-start orchestrator.
 *
 * Mounted by App.tsx as a fire-and-forget useEffect on first render.
 * Drives the slice-store hydrate sequence in the order needed for a
 * clean first paint:
 *
 *   1. App version → runtimeInfo (so Settings → About shows the
 *      real bundle version rather than the demo "0.1.0" fixture).
 *   2. SQLite housekeeping (prune empty 新对话 rows, drop legacy demo
 *      seed sessions). Best-effort — failures fall through to step 3.
 *   3. sessionsStore.hydrate (sessions + projects from SQLite).
 *   4. FTS index backfill — idempotent, no-op when already in sync.
 *   5. prefsStore.hydratePrefs (yolo / conversationWidth / gaConfig).
 *      Returns hasGAConfig for the routing branch.
 *   6. Cached LLM seed → runtimeStore (short-term hint so cold-start
 *      cosmetics show the user's real GA-configured models instead
 *      of the demo placeholders before any bridge has spawned).
 *   7. Branch on hasGAConfig:
 *      - false → route to Onboarding, skip warmup (no GA path yet)
 *      - true  → fire warmup bridge to refresh the LLM list against
 *                the current mykey.py
 *
 * This is a pure-function module, not a store. It has no own state —
 * it orchestrates side effects across stores. Tests can drive each
 * step independently by mocking the slice-store getState() calls.
 */

import { getVersion } from "@tauri-apps/api/app";

import {
  backfillFtsIfEmpty,
  deleteDemoSessions,
  deleteEmptyNewSessions,
  getPref,
} from "@/lib/db";
import { usePrefsStore } from "@/stores/prefs";
import type { LLMOption } from "@/stores/runtime";
import { useRuntimeStore } from "@/stores/runtime";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

export async function hydrateApp(): Promise<void> {
  // 1. App version — replace the empty-string sentinel in
  // DEFAULT_RUNTIME_INFO with the real value baked into
  // tauri.conf.json at build time. Failing fetch leaves the empty
  // string, which renders as `v` in Settings → About — a louder
  // "something's wrong" than silently displaying a stale literal.
  try {
    const realVersion = await getVersion();
    useRuntimeStore
      .getState()
      .patchRuntimeInfo({ workbenchVersion: realVersion });
  } catch (e) {
    console.debug("[hydrate] app.getVersion failed.", e);
  }

  // 2-4. SQLite housekeeping + sessions hydrate + FTS backfill
  try {
    // Sweep accumulated empty "新对话" rows from prior launches —
    // each auto-created session that the user never typed into
    // would otherwise stick around forever and crowd the sidebar.
    try {
      const removed = await deleteEmptyNewSessions();
      if (removed > 0) {
        console.info(
          `[hydrate] pruned ${removed} empty 新对话 row(s).`,
        );
      }
    } catch (e) {
      console.debug("[hydrate] deleteEmptyNewSessions failed.", e);
    }
    // One-time cleanup of the v0.1 demo placeholder sessions
    // (s-today-* / s-week-* / s-earlier-* from stores/demo.ts).
    try {
      const removed = await deleteDemoSessions();
      if (removed > 0) {
        console.info(
          `[hydrate] pruned ${removed} legacy demo session(s).`,
        );
      }
    } catch (e) {
      console.debug("[hydrate] deleteDemoSessions failed.", e);
    }
    await useSessionsStore.getState().hydrate();
    // One-time backfill of the FTS index for users upgrading past
    // the 004 migration. Idempotent — returns immediately when the
    // index is already in sync.
    try {
      const indexed = await backfillFtsIfEmpty();
      if (indexed > 0) {
        console.info(
          `[hydrate] backfilled ${indexed} message(s) into messages_fts.`,
        );
      }
    } catch (e) {
      console.debug("[hydrate] backfillFtsIfEmpty failed.", e);
    }
  } catch (e) {
    console.warn("[hydrate] SQLite unavailable, using demo seed.", e);
  }

  // 5. Prefs hydrate — gates the routing branch below.
  const { hasGAConfig } = await usePrefsStore.getState().hydratePrefs();

  // 6. Restore cached LLM list (written by replaceLLMs whenever a
  // bridge's `ready` event arrives). Lets cold-start cosmetics show
  // the user's real GA-configured models instead of DEFAULT_LLMS
  // before any bridge has spawned in this session. Lives outside
  // prefsStore — it's a short-term runtime hint, not a long-lived
  // preference.
  try {
    const cachedLLMs = await getPref<LLMOption[]>("llm_list");
    if (cachedLLMs && cachedLLMs.length > 0) {
      useRuntimeStore.getState().seedCachedLLMs(cachedLLMs);
    }
  } catch (e) {
    console.warn("[hydrate] llm_list pref load failed.", e);
  }

  // 7. Branch on hasGAConfig: fresh-install users go to Onboarding,
  // returning users get a warmup bridge to refresh the LLM list.
  if (!hasGAConfig) {
    useUiStore.getState().setScreen("onboarding");
    return;
  }
  void useRuntimeStore.getState().warmupLLMList();
}
