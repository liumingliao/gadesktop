import * as Dialog from "@radix-ui/react-dialog";
import {
  Cpu,
  Info,
  Keyboard,
  ShieldCheck,
  X as XIcon,
} from "@phosphor-icons/react";
import { useState } from "react";

import { SettingsAbout } from "@/components/screens/settings/SettingsAbout";
import { SettingsApproval } from "@/components/screens/settings/SettingsApproval";
import { SettingsRuntime } from "@/components/screens/settings/SettingsRuntime";
import { SettingsShortcuts } from "@/components/screens/settings/SettingsShortcuts";
import { cn } from "@/lib/utils";
import type { RuntimeInfo } from "@/types/inspector";

export type SettingsTab = "runtime" | "approval" | "shortcuts" | "about";

export interface ApprovalConfig {
  /** Tools that require approval before dispatch. */
  requiredTools: string[];
  /** Per-project always-allow rules (current project). */
  alwaysAllowProject: string[];
  /** Global always-allow rules. */
  alwaysAllowGlobal: string[];
}

export interface SettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  runtimeInfo: RuntimeInfo;
  approval: ApprovalConfig;
  /** Total project count — drives whether the Approval tab's
   * "Per-project" section renders. */
  projectCount?: number;
  /** PRD §11.5 / DESIGN.md §9 Approval. */
  yoloMode: boolean;

  defaultTab?: SettingsTab;

  /** v0.1.1+ Python mode (bundled vs external). Threaded into Runtime
   * tab so its Python panel can switch between the read-only bundled
   * card and the legacy picker. */
  useExternalPython: boolean;

  onChangeRequiredTools?: (tools: string[]) => void;
  onRemoveAlwaysAllow?: (scope: "project" | "global", tool: string) => void;
  onChangeYoloMode: (enabled: boolean) => void;
  onChangeGAPath?: () => void;
  onChangeBridgePython?: () => void;
  onReRunHealthCheck?: () => void;
  onToggleExternalPython?: (useExternal: boolean) => void;
  onCommitGAPath?: (path: string) => Promise<void>;
}

/**
 * Settings — DESIGN.md §9.
 *
 * Spec calls for a true independent macOS window (so users can keep
 * Settings open while operating the main session). Doing that needs a
 * Tauri WebviewWindow + a second React entry, which lands in #10
 * alongside IPC. For #7 we ship a modal-style overlay with the same
 * 720x560 frame and the same tab/content split — when #10 graduates
 * to a real window the React API stays exactly the same.
 *
 * Layout:
 *   - 720x560, centered (uses portal + backdrop scrim)
 *   - left tab list 180px
 *   - right content area 540px
 *   - close button top-right (Esc also works via Radix Dialog)
 *
 * Changes are immediate (DESIGN.md §9 "no sticky save button"); each
 * tab fires the matching callback when the user makes an edit. The
 * parent persists.
 */
export function Settings({
  open,
  onOpenChange,
  runtimeInfo,
  approval,
  projectCount,
  yoloMode,
  defaultTab = "runtime",
  useExternalPython,
  onChangeRequiredTools,
  onRemoveAlwaysAllow,
  onChangeYoloMode,
  onChangeGAPath,
  onChangeBridgePython,
  onReRunHealthCheck,
  onToggleExternalPython,
  onCommitGAPath,
}: SettingsProps) {
  const [tab, setTab] = useState<SettingsTab>(defaultTab);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex h-[560px] w-[720px] -translate-x-1/2 -translate-y-1/2",
            "overflow-hidden rounded-[14px] border border-line bg-elevated shadow-elevated",
            "max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)]",
          )}
        >
          <Dialog.Title className="sr-only">设置</Dialog.Title>

          <SettingsTabList tab={tab} onChange={setTab} />

          <div className="relative min-w-0 flex-1 overflow-y-auto bg-app">
            <Dialog.Close
              aria-label="关闭"
              className="absolute right-3 top-3 z-10 inline-flex size-7 items-center justify-center rounded-sm text-ink-soft transition-colors hover:bg-hover hover:text-ink"
            >
              <XIcon size={14} weight="thin" />
            </Dialog.Close>

            <div className="px-8 py-7">
              {tab === "runtime" && (
                <SettingsRuntime
                  info={runtimeInfo}
                  useExternalPython={useExternalPython}
                  onChangeGAPath={onChangeGAPath}
                  onChangeBridgePython={onChangeBridgePython}
                  onReRunHealthCheck={onReRunHealthCheck}
                  onToggleExternalPython={onToggleExternalPython}
                  onCommitGAPath={onCommitGAPath}
                />
              )}
              {tab === "approval" && (
                <SettingsApproval
                  config={approval}
                  yoloMode={yoloMode}
                  projectCount={projectCount}
                  onChangeYoloMode={onChangeYoloMode}
                  onChangeRequiredTools={onChangeRequiredTools}
                  onRemoveAlwaysAllow={onRemoveAlwaysAllow}
                />
              )}
              {tab === "shortcuts" && <SettingsShortcuts />}
              {tab === "about" && (
                <SettingsAbout
                  workbenchVersion={runtimeInfo.workbenchVersion}
                  gaBaseline={runtimeInfo.gaBaseline}
                />
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------- Tab list ----------------

function SettingsTabList({
  tab,
  onChange,
}: {
  tab: SettingsTab;
  onChange: (tab: SettingsTab) => void;
}) {
  return (
    <nav className="flex w-[180px] shrink-0 flex-col border-r border-line bg-app py-3">
      <SettingsTabButton
        active={tab === "runtime"}
        Icon={Cpu}
        label="Runtime"
        onClick={() => onChange("runtime")}
      />
      <SettingsTabButton
        active={tab === "approval"}
        Icon={ShieldCheck}
        label="Approval"
        onClick={() => onChange("approval")}
      />
      <SettingsTabButton
        active={tab === "shortcuts"}
        Icon={Keyboard}
        label="Shortcuts"
        onClick={() => onChange("shortcuts")}
      />
      <SettingsTabButton
        active={tab === "about"}
        Icon={Info}
        label="About"
        onClick={() => onChange("about")}
      />
    </nav>
  );
}

function SettingsTabButton({
  active,
  Icon,
  label,
  onClick,
}: {
  active: boolean;
  Icon: typeof Cpu;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex h-8 items-center gap-2.5 px-4 text-left text-[13px] transition-colors",
        active ? "bg-hover text-ink" : "text-ink-soft hover:text-ink",
      )}
    >
      {active && (
        <span
          className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-ink"
          aria-hidden
        />
      )}
      <Icon size={16} weight="thin" className="shrink-0" />
      {label}
    </button>
  );
}
