import { useState } from "react";

import { AppShell } from "@/components/layout/AppShell";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { EmptyState } from "@/components/screens/EmptyState";

/**
 * V0.1 Stage 2 #2 — Empty State.
 *
 * Three-pane shell with:
 *   - Top Bar (44px, traffic-light-aware)
 *   - Sidebar in empty mode (header + quick actions + muted hint)
 *   - Main: hero composer + quick prompts + keyboard hints
 *   - Inspector hidden (DESIGN.md §4.7: empty state collapses inspector)
 *
 * The Sidebar / TopBar / Composer are real components, ready to be
 * fed real data from the Zustand store in #9. Right now we only stub
 * the LLM display name; full LLM list / switcher popover comes with
 * the shadcn DropdownMenu in #6.
 *
 * No mock session list is hardcoded — the empty state is the empty
 * state. To preview the "full" sidebar we'll either wait for #3 to
 * wire the conversation view, or temporarily pass mock sessions in
 * dev (not committed).
 */
function App() {
  // Placeholder LLM name until we wire ReadyEvent.availableLLMs.
  // Bridge will hand us the prettified displayName via the IPC mirror.
  const [llmDisplayName] = useState("Claude Sonnet 4.5");

  const handleSubmit = (text: string) => {
    // #10 will dispatch a UserMessageCommand. For now log so the dev
    // overlay shows we wired the callback through.
    console.info("[empty-state] submit:", text);
  };

  const handleQuickPrompt = (prompt: string) => {
    console.info("[empty-state] quick-prompt:", prompt);
  };

  return (
    <AppShell
      topBar={<TopBar />}
      sidebar={<Sidebar sessions={[]} />}
      main={
        <EmptyState
          llmDisplayName={llmDisplayName}
          onSubmit={handleSubmit}
          onQuickPrompt={handleQuickPrompt}
        />
      }
      inspectorVisible={false}
    />
  );
}

export default App;
