/**
 * Dev-only fixtures. The DevScreenToggle (DEV-gated, see `App.tsx`)
 * wires `makeDemoToast` to a button so style review can trigger every
 * toast variant without contriving real errors.
 *
 * Production fallback values (gaConfig / approvalConfig / LLM picker
 * seeds / RuntimeInfo) used to live here under `DEMO_*` names; they
 * moved to `stores/defaults.ts` once it became clear they were load-
 * bearing in shipped builds, not test fixtures.
 */

import { type AppError, makeAppError } from "@/types/app-error";

let demoToastCounter = 0;
const DEMO_TOAST_VARIANTS: Array<
  Pick<AppError, "category" | "severity" | "message" | "hint" | "retryable">
> = [
  {
    category: "business",
    severity: "error",
    message: "Authentication failed: invalid api_key",
    hint: "check_llm_config",
    retryable: true,
  },
  {
    category: "bridge",
    severity: "error",
    message: "Connection refused by api.anthropic.com after 30s",
    hint: "network",
    retryable: true,
  },
  {
    category: "business",
    severity: "warning",
    message: "Rate limit exceeded for current LLM",
    hint: "quota_exceeded",
    retryable: false,
  },
  {
    category: "bridge",
    severity: "error",
    message: "IPC protocol mismatch: bridge expects 0.1, got 0.0.9",
    hint: null,
    retryable: false,
  },
];

export function makeDemoToast(): AppError {
  const variant =
    DEMO_TOAST_VARIANTS[demoToastCounter % DEMO_TOAST_VARIANTS.length];
  demoToastCounter += 1;
  return makeAppError({
    ...variant,
    context: "demo",
    traceback:
      "Traceback (most recent call last):\n" +
      '  File "/path/to/bridge/handlers.py", line 142, in dispatch\n' +
      '    raise BridgeError("...")\n',
  });
}
