import * as Dialog from "@radix-ui/react-dialog";
import { ArrowSquareOut, X as XIcon } from "@phosphor-icons/react";

import { MarkdownView } from "@/components/conversation/MarkdownView";
import { cn } from "@/lib/utils";
import type { Tutorial } from "@/lib/onboarding-tutorials";

interface TutorialModalProps {
  /** Tutorial to show. `null` keeps the modal closed. */
  tutorial: Tutorial | null;
  onClose: () => void;
}

/**
 * Onboarding fix-it tutorial modal — shows a hand-written snippet for
 * the specific failure the user just hit (path missing, mykey.py
 * absent, etc), plus an outbound link to the full Datawhale Hello GA
 * chapter for users who want depth.
 *
 * Styling mirrors EditProjectDialog / ProjectsDialog so onboarding's
 * help layer feels like part of the same surface family the rest of
 * the app uses for modal flows. Reuses MarkdownView (agent variant)
 * so code fences / lists / blockquotes render with the same typography
 * as agent answers — keeps the visual register consistent and avoids
 * inventing a new "tutorial body" style.
 */
export function TutorialModal({ tutorial, onClose }: TutorialModalProps) {
  return (
    <Dialog.Root
      open={tutorial !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[640px] -translate-x-1/2 -translate-y-1/2",
            "max-h-[80vh] overflow-y-auto rounded-[14px] border border-line bg-elevated shadow-elevated",
            "max-w-[calc(100vw-32px)]",
          )}
        >
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-elevated px-6 py-3.5">
            <Dialog.Title className="font-serif text-[17px] font-medium text-ink">
              {tutorial?.title ?? ""}
            </Dialog.Title>
            <Dialog.Close
              aria-label="关闭"
              className="inline-flex size-7 items-center justify-center rounded-sm text-ink-soft transition-colors hover:bg-hover hover:text-ink"
            >
              <XIcon size={14} weight="thin" />
            </Dialog.Close>
          </div>

          <div className="px-6 pb-5 pt-4">
            {tutorial && (
              <MarkdownView source={tutorial.body} variant="agent" />
            )}
          </div>

          {tutorial?.upstreamUrl && (
            <div className="sticky bottom-0 border-t border-line bg-elevated px-6 py-3.5">
              <a
                href={tutorial.upstreamUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-[12.5px] text-brand-strong transition-colors hover:text-brand-strong/80"
              >
                {tutorial.upstreamLabel ?? "查看完整教程"}
                <ArrowSquareOut size={12} weight="thin" />
              </a>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
