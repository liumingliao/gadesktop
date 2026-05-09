import { Check, Copy } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

import { cn } from "@/lib/utils";

/**
 * Markdown rendering for agent output (final answers + thinking
 * summaries). Per DESIGN.md §4.3 markdown spec.
 *
 * Stack:
 *   - react-markdown for the parse / React-tree side (no
 *     dangerouslySetInnerHTML; sanitised by virtue of the schema)
 *   - remark-gfm for GitHub-flavoured extensions (tables, task
 *     lists, autolink, strikethrough)
 *   - shiki for code-block syntax highlighting, with a hand-picked
 *     language set so we don't ship every TextMate grammar known to
 *     mankind. Languages outside the list fall back to the plain
 *     mono code block — same visual chrome, just no token colours.
 *
 * Styling philosophy: every override pulls from the existing
 * Newsreader / Inter / JetBrains-Mono token system so the
 * conversation reads as one document, not a stylesheet collage.
 *
 * The component-level overrides give us this without touching
 * globals.css — typography lives at the boundary, not in CSS
 * cascade-land.
 */

interface MarkdownViewProps {
  /** Raw markdown source from the LLM. */
  source: string;
  /**
   * Visual register. "agent" = serif body (final answer floating in
   * the document). "thinking" = serif italic muted (thinking summary
   * callout). Layout chrome (padding / background / brand bar) is
   * the caller's job — this component renders inline content only.
   */
  variant: "agent" | "thinking";
  className?: string;
}

export function MarkdownView({
  source,
  variant,
  className,
}: MarkdownViewProps) {
  const proseClass = variant === "agent" ? PROSE_AGENT : PROSE_THINKING;
  return (
    <div className={cn(proseClass, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

// ---------- Prose-level typography (variant) ----------

/**
 * Both variants share `[&_p]:mb-3`, list-marker styling, link color,
 * etc. via descendant selectors. We just swap the surrounding font
 * register at the top.
 */
const PROSE_BASE = cn(
  // Reset child margins so the parent callout (caller's box) can
  // own outer spacing without collapse fighting.
  "[&>:first-child]:mt-0 [&>:last-child]:mb-0",
  // Paragraphs.
  "[&_p]:my-3 [&_p]:leading-[1.7] [&_p:last-child]:mb-0",
  // Headings (Newsreader, slight weight contrast against body).
  "[&_h1]:mt-5 [&_h1]:mb-3 [&_h1]:font-serif [&_h1]:text-[22px] [&_h1]:font-medium [&_h1]:leading-[1.3] [&_h1]:tracking-[0.005em] [&_h1]:text-ink",
  "[&_h2]:mt-5 [&_h2]:mb-2.5 [&_h2]:font-serif [&_h2]:text-[19px] [&_h2]:font-medium [&_h2]:leading-[1.35] [&_h2]:text-ink",
  // h3 deliberately close to body size — DESIGN.md §4.3 calls this
  // out as a way to avoid jarring jumps inside the document flow.
  "[&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:font-serif [&_h3]:text-[17px] [&_h3]:font-medium [&_h3]:text-ink",
  "[&_h4]:mt-3 [&_h4]:mb-1.5 [&_h4]:font-serif [&_h4]:text-[15.5px] [&_h4]:font-medium [&_h4]:text-ink",
  // Lists. ::marker pulls list bullets into the muted register so
  // they read as structure rather than content.
  "[&_ul]:my-3 [&_ul]:ml-5 [&_ul]:list-disc",
  "[&_ol]:my-3 [&_ol]:ml-5 [&_ol]:list-decimal",
  "[&_li]:my-1 [&_li::marker]:text-ink-muted",
  "[&_li>p]:my-0", // tight paragraphs inside list items
  // Nested lists tighter.
  "[&_li>ul]:my-1 [&_li>ol]:my-1",
  // Inline code — mono token, subtle pill background.
  "[&_:not(pre)>code]:rounded-[4px] [&_:not(pre)>code]:bg-hover [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-px [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.86em] [&_:not(pre)>code]:text-ink-soft",
  // Block code lives in CodeBlock component (renders pre + own
  // styles); we keep a fallback for any pre that escapes.
  "[&_pre]:my-3.5",
  // Blockquotes — apricot-bar accent, italic, muted.
  "[&_blockquote]:my-3 [&_blockquote]:border-l-[3px] [&_blockquote]:border-brand [&_blockquote]:pl-3.5 [&_blockquote]:font-serif [&_blockquote]:italic [&_blockquote]:text-ink-soft",
  // Links.
  "[&_a]:text-brand-strong [&_a]:underline [&_a]:underline-offset-[3px] [&_a]:decoration-brand-strong/40 [&_a:hover]:decoration-brand-strong",
  // Tables — GFM extension.
  "[&_table]:my-3.5 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[14px]",
  "[&_th]:border [&_th]:border-line [&_th]:bg-surface [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-ink",
  "[&_td]:border [&_td]:border-line [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_td]:text-ink",
  // hr inside markdown.
  "[&_hr]:my-5 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-line",
  // Strong / em — keep weight in line with Newsreader.
  "[&_strong]:font-medium [&_strong]:text-ink",
  "[&_em]:italic",
  "[&_del]:text-ink-muted [&_del]:line-through",
);

const PROSE_AGENT = cn(
  PROSE_BASE,
  // The "final answer floats in the document" register (DESIGN.md §4.3).
  "font-serif text-[16.5px] leading-[1.7] tracking-[0.005em] text-ink",
);

const PROSE_THINKING = cn(
  PROSE_BASE,
  // Thinking summary register: italic serif muted (a notch lighter
  // than the answer body).
  "font-serif text-[14px] italic leading-[1.55] text-ink-soft",
);

// ---------- Code block (Shiki, fine-grained imports) ----------

/**
 * Hand-picked language set. Coding-agent users hit these constantly;
 * everything else falls through to the un-highlighted block (still
 * mono, still wrapped). Adding a language is one entry here AND a
 * matching dynamic import below — fine-grained registration via
 * `shiki/core` keeps the bundle tight (the default `shiki` entry
 * pulls every TextMate grammar known to mankind, ~600 KB of dead
 * weight including emacs-lisp / wolfram / kt / ...).
 */
const SHIKI_LANGUAGES = [
  "bash",
  "css",
  "diff",
  "html",
  "javascript",
  "json",
  "markdown",
  "python",
  "rust",
  "shell",
  "sql",
  "tsx",
  "typescript",
  "yaml",
] as const;
type ShikiLang = (typeof SHIKI_LANGUAGES)[number];

const SHIKI_THEME = "github-light";

let _highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!_highlighterPromise) {
    _highlighterPromise = createHighlighterCore({
      themes: [import("shiki/themes/github-light.mjs")],
      langs: [
        import("shiki/langs/bash.mjs"),
        import("shiki/langs/css.mjs"),
        import("shiki/langs/diff.mjs"),
        import("shiki/langs/html.mjs"),
        import("shiki/langs/javascript.mjs"),
        import("shiki/langs/json.mjs"),
        import("shiki/langs/markdown.mjs"),
        import("shiki/langs/python.mjs"),
        import("shiki/langs/rust.mjs"),
        import("shiki/langs/shellscript.mjs"),
        import("shiki/langs/sql.mjs"),
        import("shiki/langs/tsx.mjs"),
        import("shiki/langs/typescript.mjs"),
        import("shiki/langs/yaml.mjs"),
      ],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    });
  }
  return _highlighterPromise;
}

interface CodeBlockProps {
  code: string;
  language: string | null;
}

/**
 * Highlighted code block. Async render: while Shiki loads / when an
 * unsupported language is supplied, falls back to the plain mono
 * block (same chrome, no colors). The plain fallback is rendered
 * synchronously so there's no flash of empty / placeholder content.
 */
function CodeBlock({ code, language }: CodeBlockProps) {
  const lang = normalizeLanguage(language);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!lang) return;
    let cancelled = false;
    getHighlighter()
      .then((h) => {
        if (cancelled) return;
        try {
          const out = h.codeToHtml(code, {
            lang,
            theme: SHIKI_THEME,
            // Let outer wrapper own padding / background; Shiki's
            // <pre> just provides the colored tokens.
            transformers: [
              {
                pre(node) {
                  // Strip Shiki's inline background so our own
                  // container styles win — keeps the visual aligned
                  // with the rest of the document tokens.
                  delete node.properties.style;
                  return node;
                },
              },
            ],
          });
          setHtml(out);
        } catch {
          // Unknown language slip — keep the plain fallback below.
        }
      })
      .catch(() => {
        // Highlighter failed to initialize. We just keep the plain
        // block; a console.warn would spam if e.g. WebAssembly is
        // disabled in the runtime.
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return (
    <div className="group/codeblock relative my-3.5 overflow-hidden rounded-md border border-line bg-surface">
      {/* Header row: language label + Copy button. Always render the
          row so the Copy button has a stable home; if no language is
          known, the left side stays empty but the button keeps its
          position. */}
      <div className="flex items-center justify-between border-b border-line bg-elevated px-3 py-1.5">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-muted">
          {language ?? ""}
        </span>
        <CodeCopyButton code={code} />
      </div>
      <div
        className={cn(
          "overflow-x-auto px-3.5 py-3 font-mono text-[13px] leading-[1.55] text-ink",
          // Shiki's own .shiki/.shiki span colors come through the
          // dangerouslySetInnerHTML payload; no override needed.
          "[&_pre]:m-0 [&_pre]:bg-transparent [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[13px]",
        )}
      >
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * Copy button on each code block. Hover-revealed (not always-on) so
 * resting code blocks feel uncluttered; Claude.ai / ChatGPT use the
 * same hover pattern. Uses the parent's `group/codeblock` for hover
 * scoping so nested code blocks don't trigger each other.
 */
function CodeCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.warn("[CodeCopyButton] copy failed", e);
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10.5px] uppercase tracking-[0.08em] transition-opacity",
        // Hidden until hover, but stays put once you've clicked
        // (focus-visible) so keyboard users can still see feedback.
        "opacity-0 group-hover/codeblock:opacity-100 focus-visible:opacity-100",
        copied
          ? "text-success"
          : "text-ink-muted hover:bg-hover hover:text-ink-soft",
      )}
    >
      {copied ? (
        <Check size={11} weight="bold" />
      ) : (
        <Copy size={11} weight="thin" />
      )}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/**
 * react-markdown reports language via className "language-foo".
 * Returns the language id only when it's one Shiki knows about —
 * unknown / missing returns null and skips highlighting entirely
 * (so we don't fire an Effect that's guaranteed to fail).
 */
function normalizeLanguage(language: string | null): ShikiLang | null {
  if (!language) return null;
  const lower = language.toLowerCase();
  // Common aliases users / LLMs type.
  const alias: Record<string, ShikiLang> = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    rs: "rust",
    sh: "bash",
    yml: "yaml",
  };
  if (lower in alias) return alias[lower];
  if (SHIKI_LANGUAGES.includes(lower as ShikiLang)) {
    return lower as ShikiLang;
  }
  return null;
}

// ---------- react-markdown component overrides ----------

/**
 * We override exactly two elements: `code` (to route block code
 * through Shiki) and `a` (to enforce safe target=_blank). Everything
 * else uses the default DOM tag, styled via the prose class above.
 */
const COMPONENTS: Components = {
  code({ className, children }) {
    const match = /language-([\w-]+)/.exec(className ?? "");
    const text = String(children ?? "").replace(/\n$/, "");
    // Heuristic: react-markdown sends inline code without a className
    // (or a className that doesn't carry "language-"), and block code
    // with `language-foo`. If `text` contains a newline, treat as a
    // block too (covers fenced blocks without an explicit lang tag).
    const isBlock = !!match || text.includes("\n");
    if (!isBlock) {
      return <code className={className}>{children}</code>;
    }
    return <CodeBlock code={text} language={match?.[1] ?? null} />;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
};
