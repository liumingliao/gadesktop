import { ArrowsClockwise } from "@phosphor-icons/react";

import { HealthCheckCard } from "@/components/health-check/HealthCheckCard";
import { KvRow, SectionLabel } from "@/components/inspector/atoms";
import type { RuntimeInfo } from "@/types/inspector";

interface InspectorRuntimeProps {
  info: RuntimeInfo;
  onReRun?: () => void;
}

/**
 * Runtime tab — embedded Health Check Card + bridge metadata.
 *
 * Uses HealthCheckCard's "embedded" variant so the surrounding
 * Inspector chrome provides the visual frame (no double-shell).
 * Failed item action wiring would land here when the bridge starts
 * surfacing real failures; for now Inspector Runtime tab is read-only.
 */
export function InspectorRuntime({ info, onReRun }: InspectorRuntimeProps) {
  const allOk = info.healthChecks.every((c) => c.state === "success");
  const failed = info.healthChecks.filter((c) => c.state === "failed").length;

  return (
    <div>
      <SectionLabel>
        Health Check · {allOk ? "all passed" : `${failed} failed`}
      </SectionLabel>
      <HealthCheckCard items={info.healthChecks} variant="embedded" />

      <hr className="my-3.5 border-0 border-t border-line" aria-hidden />

      <dl className="m-0">
        {info.bridgePid !== undefined && (
          <KvRow k="Bridge PID" v={info.bridgePid} />
        )}
        {info.cwd && <KvRow k="cwd" v={info.cwd} />}
        <KvRow k="LLM" v={info.llmDisplayName} />
        <KvRow k="Python" v={info.pythonVersion} />
        <KvRow k="GA path" v={info.gaPath} />
        <KvRow k="GA baseline" v={info.gaBaseline.slice(0, 7)} />
        <KvRow k="Workbench" v={`v${info.workbenchVersion}`} />
      </dl>

      <button
        type="button"
        onClick={onReRun}
        className="mt-3.5 inline-flex w-full items-center justify-center gap-1.5 rounded-sm border border-line px-3 py-1.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-brand hover:bg-brand-soft hover:text-ink"
      >
        <ArrowsClockwise size={13} weight="thin" />
        Re-run health check
      </button>
    </div>
  );
}
