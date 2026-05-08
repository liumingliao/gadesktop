import { Command } from "cmdk";
import {
  ArrowLeft,
  ArrowsClockwise,
  Cube,
  Eye,
  FolderOpen,
  Gear,
  MagnifyingGlass,
  Plus,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { StatusIcon } from "@/lib/status-icon";
import { cn } from "@/lib/utils";
import type { Session } from "@/types/session";

import "./command-palette.css";

export interface LLMOption {
  index: number;
  displayName: string;
  isCurrent: boolean;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  sessions: Session[];
  llms?: LLMOption[];

  onNewChat?: () => void;
  onOpenSession?: (id: string) => void;
  onSwitchLLM?: (index: number) => void;
  onReRunHealthCheck?: () => void;
  onOpenSettings?: () => void;
  onToggleInspector?: () => void;
  onAttachGAFolder?: () => void;

  /** Called when the user presses Enter on an empty/no-match palette
   * (DESIGN.md §8 "Empty state") — typically: open new chat with this
   * text as the first message. */
  onSubmitFreeText?: (text: string) => void;
}

/**
 * ⌘K command palette. DESIGN.md §8.
 *
 * Centered overlay (not pinned-top), 560px wide, max-height 420px,
 * surface-elevated bg + shadow-elevated + 14px radius. Backdrop is
 * surface-overlay rgba(31,27,23,0.4) — no blur (Notion-style flat
 * scrim, not magazine-feel blur).
 *
 * Built on cmdk. We use cmdk directly rather than going through
 * shadcn/command — shadcn's command is just cmdk + Tailwind classes,
 * and we already have our own design tokens. Avoids the shadcn init
 * step touching globals.css.
 *
 * V0.1 contents (intentionally narrow):
 *
 *   - "New chat" (always first)
 *   - Recent sessions (≤8, fuzzy on title)
 *   - Actions: Switch LLM (nested submenu) / Re-run health check /
 *     Open settings / Toggle inspector / Attach GA folder
 *
 * Deliberately excluded: cross-session full-text search, theme
 * switcher, quick prompt insertion, destructive actions. See
 * DESIGN.md §8 "故意排除".
 */
export function CommandPalette(props: CommandPaletteProps) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<"root" | "switch-llm">("root");

  // Reset internal state every time the palette opens — feels less
  // surprising than persisting across opens (DESIGN.md §8: no recent-
  // searches persistence at V0.1). Schedule on a tick so the
  // react-hooks/set-state-in-effect rule stays happy.
  useEffect(() => {
    if (!props.open) return;
    const t = setTimeout(() => {
      setSearch("");
      setPage("root");
    }, 0);
    return () => clearTimeout(t);
  }, [props.open]);

  const close = () => props.onOpenChange(false);

  return (
    <Command.Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      label="Command palette"
      shouldFilter={page === "root"}
    >
      <div className="relative shrink-0">
        <MagnifyingGlass
          size={16}
          weight="thin"
          className="pointer-events-none absolute left-4 top-4 text-ink-muted"
        />
        <Command.Input
          value={search}
          onValueChange={setSearch}
          placeholder={
            page === "switch-llm" ? "搜索 LLM…" : "搜索 session 或输入命令…"
          }
          autoFocus
        />
        <kbd className="pointer-events-none absolute right-4 top-[14px] rounded-sm border border-line bg-app px-1.5 py-px font-mono text-[10px] text-ink-muted">
          Esc
        </kbd>
      </div>

      <Command.List>
        {page === "root" ? (
          <RootPage
            search={search}
            sessions={props.sessions}
            onNewChat={() => {
              props.onNewChat?.();
              close();
            }}
            onOpenSession={(id) => {
              props.onOpenSession?.(id);
              close();
            }}
            onEnterSwitchLLM={() => setPage("switch-llm")}
            llmCount={props.llms?.length ?? 0}
            currentLLM={props.llms?.find((l) => l.isCurrent)?.displayName}
            onReRunHealthCheck={() => {
              props.onReRunHealthCheck?.();
              close();
            }}
            onOpenSettings={() => {
              props.onOpenSettings?.();
              close();
            }}
            onToggleInspector={() => {
              props.onToggleInspector?.();
              close();
            }}
            onAttachGAFolder={() => {
              props.onAttachGAFolder?.();
              close();
            }}
            onSubmitFreeText={(text) => {
              props.onSubmitFreeText?.(text);
              close();
            }}
          />
        ) : (
          <SwitchLLMPage
            llms={props.llms ?? []}
            onPick={(index) => {
              props.onSwitchLLM?.(index);
              close();
            }}
            onBack={() => setPage("root")}
          />
        )}
      </Command.List>
    </Command.Dialog>
  );
}

// ---------------- Root page ----------------

function RootPage({
  search,
  sessions,
  onNewChat,
  onOpenSession,
  onEnterSwitchLLM,
  llmCount,
  currentLLM,
  onReRunHealthCheck,
  onOpenSettings,
  onToggleInspector,
  onAttachGAFolder,
  onSubmitFreeText,
}: {
  search: string;
  sessions: Session[];
  onNewChat: () => void;
  onOpenSession: (id: string) => void;
  onEnterSwitchLLM: () => void;
  llmCount: number;
  currentLLM?: string;
  onReRunHealthCheck: () => void;
  onOpenSettings: () => void;
  onToggleInspector: () => void;
  onAttachGAFolder: () => void;
  onSubmitFreeText: (text: string) => void;
}) {
  // Show only the most recent 8 sessions when there's no search; cmdk
  // handles fuzzy filtering when the user starts typing.
  const recentSessions = sessions.slice(0, 8);

  return (
    <>
      <Command.Empty>
        <EmptyHint search={search} onSubmit={() => onSubmitFreeText(search)} />
      </Command.Empty>

      {/* Always-first: New chat. Plain Item, no group header. */}
      <Command.Item value="new-chat new chat 新建对话" onSelect={onNewChat}>
        <PaletteRow Icon={Plus} label="New Chat" shortcut="⌘N" />
      </Command.Item>

      {/* Sessions */}
      {recentSessions.map((s) => (
        <Command.Item
          key={s.id}
          value={`session ${s.title} ${s.summary ?? ""}`}
          onSelect={() => onOpenSession(s.id)}
        >
          <PaletteRow
            iconNode={<StatusIcon status={s.status} size={14} />}
            label={s.title}
            sub={s.summary}
          />
        </Command.Item>
      ))}

      {/* Actions */}
      <Command.Item
        value="switch llm 切换"
        onSelect={onEnterSwitchLLM}
        disabled={llmCount === 0}
      >
        <PaletteRow
          Icon={Cube}
          label="Switch LLM"
          sub={currentLLM ? `current: ${currentLLM}` : undefined}
          shortcut="→"
        />
      </Command.Item>
      <Command.Item
        value="rerun health check 体检"
        onSelect={onReRunHealthCheck}
      >
        <PaletteRow Icon={ArrowsClockwise} label="Re-run health check" />
      </Command.Item>
      <Command.Item value="open settings 设置" onSelect={onOpenSettings}>
        <PaletteRow Icon={Gear} label="Open settings" shortcut="⌘," />
      </Command.Item>
      <Command.Item value="toggle inspector" onSelect={onToggleInspector}>
        <PaletteRow Icon={Eye} label="Toggle inspector" shortcut="⌘E" />
      </Command.Item>
      <Command.Item
        value="attach ga folder 切换 GA 路径"
        onSelect={onAttachGAFolder}
      >
        <PaletteRow Icon={FolderOpen} label="Attach GA folder" />
      </Command.Item>
    </>
  );
}

function EmptyHint({
  search,
  onSubmit,
}: {
  search: string;
  onSubmit: () => void;
}) {
  if (search.trim() === "") {
    return (
      <div className="px-4 py-6 text-center text-[12.5px] italic text-ink-muted">
        没有匹配项。
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-6 text-center">
      <div className="text-[12.5px] italic text-ink-muted">没找到。</div>
      <button
        type="button"
        onClick={onSubmit}
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-strong transition-colors hover:text-ink"
      >
        Enter 直接发问？
        <span className="rounded-sm border border-line bg-app px-1.5 py-px font-mono text-[10px] text-ink-muted">
          ↵
        </span>
      </button>
    </div>
  );
}

// ---------------- Switch LLM page ----------------

function SwitchLLMPage({
  llms,
  onPick,
  onBack,
}: {
  llms: LLMOption[];
  onPick: (index: number) => void;
  onBack: () => void;
}) {
  return (
    <>
      <Command.Item value="back" onSelect={onBack}>
        <PaletteRow Icon={ArrowLeft} label="Back" sub="主菜单" />
      </Command.Item>
      {llms.map((llm) => (
        <Command.Item
          key={llm.index}
          value={`llm ${llm.displayName}`}
          onSelect={() => onPick(llm.index)}
        >
          <PaletteRow
            Icon={Cube}
            label={llm.displayName}
            sub={llm.isCurrent ? "current" : undefined}
            checked={llm.isCurrent}
          />
        </Command.Item>
      ))}
      {llms.length === 0 && (
        <Command.Empty>
          <div className="px-4 py-6 text-center text-[12.5px] italic text-ink-muted">
            没有可用的 LLM 配置。
          </div>
        </Command.Empty>
      )}
    </>
  );
}

// ---------------- Row primitive ----------------

function PaletteRow({
  Icon,
  iconNode,
  label,
  sub,
  shortcut,
  checked,
}: {
  Icon?: PhosphorIcon;
  iconNode?: React.ReactNode;
  label: string;
  sub?: string;
  shortcut?: string;
  checked?: boolean;
}) {
  return (
    <div className="flex w-full items-center gap-2.5">
      <span className="inline-flex shrink-0 text-ink-soft">
        {iconNode ?? (Icon && <Icon size={16} weight="thin" />)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
        {label}
      </span>
      {sub && (
        <span className="shrink-0 text-[11.5px] text-ink-muted">{sub}</span>
      )}
      {checked && (
        <span className="shrink-0 text-[12px] text-brand-strong">✓</span>
      )}
      {shortcut && (
        <span
          className={cn(
            "shrink-0 rounded-sm border border-line bg-app px-1.5 py-px font-mono text-[10px] text-ink-muted",
            !sub && !checked && "ml-auto",
          )}
        >
          {shortcut}
        </span>
      )}
    </div>
  );
}
