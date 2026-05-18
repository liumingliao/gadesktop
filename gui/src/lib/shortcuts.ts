import { isMac } from "@/lib/platform";

/**
 * Semantic → display formatter for keyboard shortcuts.
 *
 *   formatShortcut("Mod+K")        // Mac: "⌘K"     · Win: "Ctrl+K"
 *   formatShortcut("Mod+Shift+P")  // Mac: "⌘⇧P"    · Win: "Ctrl+Shift+P"
 *   formatShortcut("Alt+↑")        // Mac: "⌥↑"     · Win: "Alt+↑"
 *   formatShortcut("Enter")        // both:  "Enter"
 *
 * Input combo uses `+` to separate modifier tokens. Tokens that
 * appear in the OS map (Mod / Cmd / Ctrl / Alt / Option / Shift /
 * Enter / Esc) are translated; anything else (letters, arrows,
 * punctuation) passes through unchanged.
 *
 * Mac output: glyphs concatenated with no separator — `⌘K` reads as
 * one chord on macOS chrome (Slack, Notion, Linear convention) and
 * KbdCombo.tsx renders it as a single chip.
 *
 * Win output: word names joined with `+` — `Ctrl+K` is the universal
 * Win/Linux convention; KbdCombo splits on `+` and shows each token
 * as its own chip.
 *
 * The `Mod` token is the canonical "platform-modifier" placeholder:
 * use it instead of hard-coding `Cmd` or `Ctrl` so the same input
 * works for both OSes.
 */

const MAC_GLYPHS: Record<string, string> = {
  Mod: "⌘",
  Cmd: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Option: "⌥",
  Shift: "⇧",
  Enter: "↵",
  Escape: "Esc",
  Esc: "Esc",
};

const WIN_NAMES: Record<string, string> = {
  Mod: "Ctrl",
  Cmd: "Ctrl",
  Ctrl: "Ctrl",
  Alt: "Alt",
  Option: "Alt",
  Shift: "Shift",
  Enter: "Enter",
  Escape: "Esc",
  Esc: "Esc",
};

export function formatShortcut(combo: string): string {
  const parts = combo.split("+");
  if (isMac) {
    return parts.map((p) => MAC_GLYPHS[p] ?? p).join("");
  }
  return parts.map((p) => WIN_NAMES[p] ?? p).join("+");
}
