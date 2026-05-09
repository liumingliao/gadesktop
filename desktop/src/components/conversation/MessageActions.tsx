import { Check, Copy, FloppyDisk } from "@phosphor-icons/react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Per-reply action bar — sits below the agent's final answer
 * (DESIGN.md §4.3 Message Actions).
 *
 * V0.1 actions:
 *
 *   - Copy   → copies the raw markdown source to the clipboard.
 *              Markdown is what users want when pasting into Notion
 *              / Obsidian / Slack — those targets re-render the
 *              syntax. Pasting the visually-rendered text would
 *              throw away structure.
 *   - Save   → opens a Tauri save-as dialog and writes the markdown
 *              to disk. Default filename `ga-{timestamp}.md` so
 *              successive saves don't fight each other.
 *
 * Always-visible (not hover-only): per dogfood feedback, hover-only
 * affordances make users hunt around. The buttons are muted enough
 * that they recede during reading and surface on intent.
 *
 * State machine per button: idle → done (1.5s) → idle. Two refs
 * so timers can be cleared on unmount or rapid re-clicks.
 */

interface MessageActionsProps {
  /** Markdown source to operate on. */
  source: string;
}

export function MessageActions({ source }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);

  // Cancel pending feedback resets if the message unmounts mid-flash.
  useEffect(() => {
    return () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.warn("[MessageActions] copy failed", e);
    }
  };

  const onSave = async () => {
    // Default filename `ga-{timestamp}.md`. Timestamp keeps successive
    // saves from clobbering each other; user can edit in the dialog
    // before confirming.
    const stamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[-:T]/g, "")
      // YYYYMMDDhhmmss is hard to scan; insert one dash between date
      // and time so the default name reads cleanly.
      .replace(/^(\d{8})(\d{6})$/, "$1-$2");
    const defaultName = `ga-${stamp}.md`;

    try {
      const path = await save({
        defaultPath: defaultName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      // User cancelled: save() resolves to null. Silently noop.
      if (!path) return;
      await writeTextFile(path, source);
      setSaved(true);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      console.warn("[MessageActions] save failed", e);
    }
  };

  return (
    <div className="mt-2 flex items-center gap-2">
      <ActionButton
        active={copied}
        idleIcon={<Copy size={13} weight="thin" />}
        idleLabel="Copy"
        activeIcon={<Check size={13} weight="bold" />}
        activeLabel="Copied"
        onClick={onCopy}
      />
      <ActionButton
        active={saved}
        idleIcon={<FloppyDisk size={13} weight="thin" />}
        idleLabel="Save"
        activeIcon={<Check size={13} weight="bold" />}
        activeLabel="Saved"
        onClick={onSave}
      />
    </div>
  );
}

function ActionButton({
  active,
  idleIcon,
  idleLabel,
  activeIcon,
  activeLabel,
  onClick,
}: {
  active: boolean;
  idleIcon: React.ReactNode;
  idleLabel: string;
  activeIcon: React.ReactNode;
  activeLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[12px] transition-colors",
        active
          ? "text-success"
          : "text-ink-muted hover:bg-hover hover:text-ink-soft",
      )}
    >
      {active ? activeIcon : idleIcon}
      <span>{active ? activeLabel : idleLabel}</span>
    </button>
  );
}
