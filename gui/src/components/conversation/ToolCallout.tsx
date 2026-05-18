import {
  BookmarkSimple,
  Brain,
  CaretDown,
  CheckCircle,
  CircleNotch,
  CursorClick,
  FilePlus,
  FileText,
  GlobeSimple,
  type Icon,
  PauseCircle,
  PencilSimpleLine,
  Prohibit,
  Terminal,
  XCircle,
} from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

import { ApprovalForm } from "@/components/conversation/ApprovalForm";
import { cn } from "@/lib/utils";
import type {
  ConversationToolEvent,
  OnApprove,
  ToolEventStatus,
} from "@/types/conversation";

interface ToolCalloutProps {
  tool: ConversationToolEvent;
  /** When status === "waiting_approval", drives the inline form. */
  onApprove?: OnApprove;
  /** Approval form's currently-recorded decision (for the "decided"
   * post-state look). Pass undefined while still pending. */
  approvalDecision?: string;
  /** Name of the project the active session belongs to (if any) —
   * powers the "Always allow in {projectName}" button label and
   * controls whether the project-scoped decision is offered at all. */
  projectName?: string;
}

/**
 * Tool visual tier — three rendering paths, selected by status:
 *
 *   "hidden"  — `no_tool`. GA's null-op tool; its semantic ("agent
 *               chose not to dispatch") is already covered by the
 *               TurnMarker's GA summary. Rendering a callout for
 *               it would only crowd the conversation.
 *
 *   "inline"  — ANY tool in a settled success state. Compact
 *               single-row pill (icon + name + primary arg
 *               preview) with click-to-expand for full args /
 *               result. Visual consistency across tools beats
 *               case-by-case prominence: users skimming a finished
 *               conversation see a clean narrative; users who want
 *               to audit a specific operation (e.g. file_patch
 *               diff, code_run output) click to expand.
 *
 *   "block"   — attention-demanding states: waiting_approval /
 *               failed / running / denied. These ALL need visual
 *               prominence regardless of which tool produced them
 *               (the user must see them; in-flight needs spinner
 *               space; errors need warning weight).
 *
 * Earlier design (commit 1b283c1) split block/inline by tool name
 * — file_patch / file_write / code_run stayed as block in settled
 * state for "audit value". That left settled turns rendering as a
 * jarring mix of pill + block depending on which tools fired,
 * violating visual consistency. Dropped: settled state is always
 * pill, full content lives one click away.
 */
function pickToolTier(tool: ConversationToolEvent): "hidden" | "inline" | "block" {
  if (tool.name === "no_tool") return "hidden";
  const isSettledSuccess =
    tool.status === "success-current" || tool.status === "success-historical";
  return isSettledSuccess ? "inline" : "block";
}

/**
 * Tool callout — dispatcher between the three visual tiers. See
 * `pickToolTier` for the rationale behind the split.
 */
export function ToolCallout({
  tool,
  onApprove,
  approvalDecision,
  projectName,
}: ToolCalloutProps) {
  const tier = pickToolTier(tool);
  if (tier === "hidden") return null;
  if (tier === "inline") return <InlineToolPill tool={tool} />;
  return (
    <BlockToolCallout
      tool={tool}
      onApprove={onApprove}
      approvalDecision={approvalDecision}
      projectName={projectName}
    />
  );
}

/**
 * Block-form tool callout — the original "Notion callout" treatment.
 * Used for external-world tools (file_patch / file_write / code_run)
 * in settled state, and for ANY tool in attention-demanding states
 * (waiting_approval / failed / running / denied). Per DESIGN.md §4.5.
 *
 * Six visual states (see ToolEventStatus):
 *
 *   running             apricot bar + spinning notch + auto-open
 *   success-current     apricot bar + check + auto-open
 *   success-historical  near-invisible bar + muted check + auto-collapse
 *                       (fades into the document)
 *   waiting_approval    amber bar + pause + amber 4% tint + FORCED OPEN
 *   failed              red bar + X + red 4% tint + FORCED OPEN
 *   denied              muted bar + prohibit + auto-collapse
 */
function BlockToolCallout({
  tool,
  onApprove,
  approvalDecision,
  projectName,
}: ToolCalloutProps) {
  const cfg = STATUS_CONFIG[tool.status];
  const forcedOpen = cfg.forcedOpen;
  const [openManual, setOpenManual] = useState(cfg.defaultOpen);
  const open = forcedOpen || openManual;

  return (
    <div
      className={cn(
        "relative my-3 overflow-hidden rounded-md border border-line transition-all",
        cfg.bgClass,
      )}
    >
      <div className={cn("absolute inset-y-0 left-0 w-[3px]", cfg.barClass)} />

      {/* Head */}
      <div
        onClick={!forcedOpen ? () => setOpenManual((v) => !v) : undefined}
        className={cn(
          "flex select-none items-center gap-2.5 px-4 pt-3.5",
          open ? "pb-2" : "pb-3.5",
          !forcedOpen && "cursor-pointer",
        )}
      >
        <span className="inline-flex shrink-0">
          <StatusBit status={tool.status} />
        </span>
        <span className="font-mono text-[13px] font-medium text-ink">
          {tool.name}
        </span>
        <span className="ml-auto flex items-center gap-2.5 text-[11px] text-ink-muted">
          <StatusPill status={tool.status} />
          {tool.elapsed && <span>{tool.elapsed}</span>}
          {!forcedOpen && (
            <CaretDown
              size={12}
              weight="thin"
              className={cn(
                "transition-transform duration-150",
                open && "rotate-180",
              )}
            />
          )}
        </span>
      </div>

      {/* Collapsed lead */}
      {!open && tool.summary && (
        <div className="ml-[26px] px-4 pb-3.5 text-[12.5px] text-ink-muted">
          {tool.summary}
        </div>
      )}

      {/* Expanded body */}
      {open && (
        <div className="animate-fade-in px-4 pb-4">
          {tool.summary && (
            <div className="mb-2.5 text-[13px] text-ink-soft">
              {tool.summary}
            </div>
          )}

          {tool.status === "waiting_approval" && tool.approvalId ? (
            <ApprovalForm
              tool={tool}
              onApprove={onApprove}
              approvalDecision={approvalDecision}
              projectName={projectName}
            />
          ) : (
            <>
              {tool.args && Object.keys(tool.args).length > 0 && (
                <ArgsBlock args={tool.args} />
              )}
              {tool.resultPreview && (
                <ResultBlock content={tool.resultPreview} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- internals ----------

interface StatusConfig {
  /** Tailwind classes for the 3px left bar. */
  barClass: string;
  /** Tailwind classes for the callout background. Most states use the
   * surface tint (no background); waiting / failed get 4% color tints
   * to add forced visibility per DESIGN.md (prototype refinement we'll
   * codify in the v0.2 patch). */
  bgClass: string;
  forcedOpen: boolean;
  defaultOpen: boolean;
}

const STATUS_CONFIG: Record<ToolEventStatus, StatusConfig> = {
  running: {
    barClass: "bg-brand",
    bgClass: "bg-surface",
    forcedOpen: false,
    defaultOpen: true,
  },
  "success-current": {
    barClass: "bg-brand",
    bgClass: "bg-surface",
    forcedOpen: false,
    defaultOpen: true,
  },
  // Faint bar + app background = visually fades into the document
  // ("we already finished this; don't pull the eye").
  "success-historical": {
    barClass: "bg-brand/20",
    bgClass: "bg-app",
    forcedOpen: false,
    defaultOpen: false,
  },
  waiting_approval: {
    barClass: "bg-warning",
    bgClass: "bg-warning/[0.04]",
    forcedOpen: true,
    defaultOpen: true,
  },
  failed: {
    barClass: "bg-error",
    bgClass: "bg-error/[0.04]",
    forcedOpen: true,
    defaultOpen: true,
  },
  denied: {
    barClass: "bg-ink-muted",
    bgClass: "bg-surface",
    forcedOpen: false,
    defaultOpen: false,
  },
};

function StatusBit({ status }: { status: ToolEventStatus }) {
  if (status === "running")
    return (
      <span className="spin">
        <CircleNotch size={16} weight="thin" className="text-brand-strong" />
      </span>
    );
  if (status === "success-current")
    return (
      <CheckCircle size={16} weight="thin" className="text-brand-strong" />
    );
  if (status === "success-historical")
    return <CheckCircle size={16} weight="thin" className="text-ink-muted" />;
  if (status === "waiting_approval")
    return <PauseCircle size={16} weight="thin" className="text-warning" />;
  if (status === "failed")
    return <XCircle size={16} weight="thin" className="text-error" />;
  // denied
  return <Prohibit size={16} weight="thin" className="text-ink-muted" />;
}

function StatusPill({ status }: { status: ToolEventStatus }) {
  const text = STATUS_PILL_TEXT[status];
  return (
    <span
      className={cn(
        "rounded-full px-2 py-px text-[10px] font-medium tracking-[0.02em]",
        STATUS_PILL_CLASS[status],
      )}
    >
      {text}
    </span>
  );
}

const STATUS_PILL_TEXT: Record<ToolEventStatus, string> = {
  running: "running",
  "success-current": "success",
  "success-historical": "success",
  waiting_approval: "awaiting approval",
  failed: "failed",
  denied: "denied",
};

const STATUS_PILL_CLASS: Record<ToolEventStatus, string> = {
  running: "bg-brand/[0.18] text-brand-strong",
  "success-current": "bg-success/10 text-success",
  "success-historical": "bg-success/10 text-success",
  waiting_approval: "bg-warning/[0.12] text-warning",
  failed: "bg-error/10 text-error",
  denied: "bg-hover text-ink-muted",
};

// ---------- arg / result blocks (fallbacks) ----------

function ArgsBlock({ args }: { args: Record<string, unknown> }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-[8px] border border-line bg-app px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] text-ink-soft">
      {Object.entries(args).map(([k, v]) => (
        <Line key={k} k={k} v={v} />
      ))}
    </pre>
  );
}

function Line({ k, v }: { k: string; v: unknown }) {
  return (
    <div>
      <span className="text-ink-muted">{k}: </span>
      <span>{stringifyValue(v)}</span>
    </div>
  );
}

function stringifyValue(v: unknown): ReactNode {
  if (typeof v === "string") return JSON.stringify(v);
  return JSON.stringify(v);
}

function ResultBlock({ content }: { content: string }) {
  return (
    <div className="mt-2.5">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
        Result
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-[8px] border border-line bg-app px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] text-ink-soft">
        {content}
      </pre>
    </div>
  );
}

// ---------- inline pill ----------

/**
 * Per-tool display metadata for the inline pill. Maps GA's native
 * tool name to (Phosphor icon, Chinese friendly label).
 *
 * The pill renders Chinese as the left-zone primary label (matches
 * the conversation document's Chinese serif register) and surfaces
 * the GA name as right-zone mono metadata — so audit-minded users
 * can still scan the wire-level tool that ran without losing the
 * prose-friendly main view. See pill render below for the layout.
 *
 * Icons: web_scan (read) vs web_execute_js (act) get different
 * glyphs (GlobeSimple vs CursorClick) so the two browser tools are
 * distinguishable at a glance — query/script arg differentiation
 * alone is unreliable when arg-preview is empty.
 *
 * Unknown / future GA tools fall back to a name-only pill via
 * `TOOL_META[name] ?? null`; no icon, no Chinese label, just the
 * raw GA name in mono — visually quieter than an arbitrary icon
 * picked under uncertainty.
 */
const TOOL_META: Record<string, { icon: Icon; zh: string }> = {
  web_scan: { icon: GlobeSimple, zh: "读取网页" },
  web_execute_js: { icon: CursorClick, zh: "执行网页脚本" },
  file_read: { icon: FileText, zh: "读取文件" },
  file_write: { icon: FilePlus, zh: "写入文件" },
  file_patch: { icon: PencilSimpleLine, zh: "修改文件" },
  code_run: { icon: Terminal, zh: "运行代码" },
  update_working_checkpoint: { icon: BookmarkSimple, zh: "保存关键上下文" },
  start_long_term_update: { icon: Brain, zh: "写入长期记忆" },
};

/**
 * Compact single-line representation of a settled, read-only tool
 * invocation. Two-zone layout:
 *
 *   [Icon] 读取网页 · "电影 Drama 评价"            web_scan  ▾
 *   └─ left zone (flex-grow): icon + zh label + arg preview
 *                              └─ user-facing prose register
 *                                                          └─ right zone
 *                                                              (shrink-0):
 *                                                              mono GA
 *                                                              name + chevron
 *
 * Visual hierarchy via typography rather than chrome: 13px serif
 * ink-soft for the primary label, 11px mono ink-muted for the GA
 * name. A reader's eye walks the left zone in the conversation's
 * natural reading register; an auditor scanning for "did web_scan
 * really run?" hits the mono ID on the right.
 *
 * Inline tier is *only* reached by settled-success tools (see
 * pickToolTier), so no leading status icon — the tool-specific
 * Phosphor glyph carries the slot. Failure / running /
 * awaiting-approval renders via BlockToolCallout where the status
 * bit carries real signal.
 */
function InlineToolPill({ tool }: { tool: ConversationToolEvent }) {
  const [open, setOpen] = useState(false);
  const meta = TOOL_META[tool.name];
  const ToolIcon = meta?.icon;
  const preview = previewArgs(tool.name, tool.args);

  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left transition-colors",
          "text-ink-soft hover:bg-hover hover:text-ink",
        )}
      >
        {/* Left zone — friendly prose register. */}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {ToolIcon && (
            <ToolIcon
              size={14}
              weight="thin"
              className="shrink-0 text-ink-soft"
            />
          )}
          <span className="truncate font-serif text-[13px]">
            {meta?.zh ?? (
              // Unknown tool: surface the GA name itself as the
              // primary label (mono) so the pill still has a usable
              // identity — better than a blank chip.
              <span className="font-mono">{tool.name}</span>
            )}
            {preview && (
              <span className="ml-1.5 text-ink-muted">· {preview}</span>
            )}
          </span>
        </span>
        {/* Right zone — audit metadata. Hidden for the unknown-tool
            fallback above, since the GA name already took the
            primary label slot. */}
        <span className="flex shrink-0 items-center gap-1.5">
          {meta && (
            <span className="font-mono text-[11px] text-ink-muted">
              {tool.name}
            </span>
          )}
          <CaretDown
            size={10}
            weight="thin"
            className={cn(
              "text-ink-muted transition-transform duration-150",
              open && "rotate-180",
            )}
          />
        </span>
      </button>

      {open && (
        <div className="ml-3 mt-1 animate-fade-in border-l border-line/60 pl-3">
          {tool.args && Object.keys(tool.args).length > 0 && (
            <ArgsBlock args={tool.args} />
          )}
          {tool.resultPreview && <ResultBlock content={tool.resultPreview} />}
        </div>
      )}
    </div>
  );
}

/**
 * Pick the most useful single-line arg preview for a given tool.
 * Tool-specific rules — each tool exposes its primary input
 * differently and some tools (web_execute_js's JS code,
 * update_working_checkpoint's nested args) have no preview worth
 * showing.
 *
 * Returns null = no preview, render pill without the trailing
 * "· {preview}" segment. The icon + zh label already carries
 * enough identity in those cases.
 */
const PREVIEW_MAX_LEN = 80;

function previewArgs(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  const get = (k: string): string | null => {
    const v = args[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  const truncate = (s: string | null): string | null =>
    s && s.length > PREVIEW_MAX_LEN ? s.slice(0, PREVIEW_MAX_LEN) + "…" : s;
  switch (toolName) {
    case "file_read":
    case "file_write":
    case "file_patch":
      return truncate(get("path"));
    case "web_scan": {
      // Quote-wrap query so it reads as user-typed text vs raw URL.
      const q = get("query");
      if (q) return truncate(`"${q}"`);
      return truncate(get("url"));
    }
    case "web_execute_js":
      // JS code as a preview is uninformative (long, syntax-heavy)
      // — the icon + "执行网页脚本" label already conveys the action.
      // Full code lives one click away in the expanded ArgsBlock.
      return null;
    case "code_run":
      // First non-comment, non-empty line of the script. GA scripts
      // are bash or python; both use `#` for comments.
      return truncate(firstCodeLine(get("script") ?? get("command")));
    case "update_working_checkpoint":
      // Args are structured nested context; no single-line preview
      // captures the intent. Action label suffices.
      return null;
    case "start_long_term_update": {
      const q = get("query") ?? get("topic") ?? get("key");
      return truncate(q);
    }
    case "recall":
      return truncate(get("query") ?? get("key"));
    default:
      return truncate(get("path") ?? get("query") ?? get("command"));
  }
}

/**
 * For code_run: skip leading shebangs / comment lines / blank lines
 * and return the first line of actual code. Falls back to the raw
 * first line if no non-comment line is found within the first 20
 * (defensive cap so a 5000-line script of pure comments doesn't
 * scan to the end).
 */
function firstCodeLine(src: string | null): string | null {
  if (!src) return null;
  const lines = src.split("\n", 20);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return src.split("\n", 1)[0]?.trim() || null;
}
