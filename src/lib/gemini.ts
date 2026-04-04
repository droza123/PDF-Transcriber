/**
 * Thin shim that preserves the public API consumed by convert.ts.
 * The actual provider logic is in providers/gemini.ts; the retry/fallback
 * orchestration is in providers/orchestrator.ts.
 */
import { callWithRetry, type OrchestratorCallOptions } from './providers/orchestrator';
import type { ProviderResult } from './providers/types';
import { getSettings } from './settings';
import { getActiveProvider } from './providers/registry';

// Re-export types for backward compat
export type GeminiCallOptions = OrchestratorCallOptions;
export type GeminiResult = ProviderResult;

/** Dynamic batch size from settings. */
export function getBatchSize(): number {
  return getSettings().batchSize;
}

// ── Prompts (provider-agnostic, stay here) ──────────────────────────────────

const PRESCAN_PROMPT = `Analyze this PDF document and produce a structural outline in Markdown. Include:

1. The document's page numbering scheme (e.g., "roman numerals i-xii for front matter, then arabic 1-234 for body", or "no page numbers visible").
2. A hierarchical table of contents using Markdown headings to show the nesting:
   # Part/major division
   ## Chapter/section
   ### Subsection
   #### Sub-subsection
   Include the page number (as printed in the document) next to each heading if visible.

Output ONLY the outline — no content, no commentary.`;

function buildBatchPrompt(batchNum: number, totalBatches: number, outline: string, translationLanguage?: string): string {
  const settings = getSettings();
  const extra = settings.outputNotes ? `\n\nCustom instructions:\n${settings.outputNotes}` : '';

  const translationBlock = translationLanguage
    ? `\n\nTranslation:
- Translate ALL document content into ${translationLanguage}.
- The structural outline above is in the original language — use it to match heading levels, but translate the heading text into ${translationLanguage}.
- Translate footnote and endnote text into ${translationLanguage}.
- Keep bibliographic references (titles, authors, publishers, journal names) in their original language.`
    : '';

  return `Convert this PDF to Markdown optimized for AI-assisted academic citation.
This is batch ${batchNum} of ${totalBatches} from the source document.

Here is the document's structural outline for context (use this to determine correct heading levels and understand where this batch falls in the document):

${outline}

Page numbering:
- Look for printed page numbers on each page of this PDF.
- If page numbers are visible, place <!-- page: N --> at the start of each page's content, where N is the ACTUAL printed page number from the document (which may be roman numerals like "iv", or start at any number — use exactly what's printed).
- If no page numbers are visible on any page, do NOT insert page markers. Instead, ensure proper heading hierarchy so the document is navigable by section.

Layout awareness:
- Some PDFs contain scanned two-page spreads (two document pages side by side on a single PDF page). When you detect this, read LEFT page first, then RIGHT page. Do not interleave or duplicate content across the two pages. Each document page should appear exactly once in the output.${translationBlock}

Content rules:
1. Use the heading hierarchy from the outline above to determine correct heading levels (# ## ### etc.). Match headings to the outline — do not guess levels independently.
2. If the document has a table of contents, render its entries as plain text — not as headings. Only use heading syntax for actual chapter/section titles in the body.
3. Preserve paragraph structure with blank lines between paragraphs.
4. Convert tables to Markdown table syntax.
5. Preserve footnotes using [^N] syntax with definitions at section end.
6. Preserve endnotes and bibliographic references EXACTLY as written${translationLanguage ? ' (in their original language)' : ''}.
7. Describe figures/images in [brackets], e.g. [Figure 3: Bar chart of enrollment].
8. Fix hyphenation artifacts from PDF line-breaking.
9. Preserve block quotes using > syntax.
10. Preserve numbered and bulleted lists exactly.
11. Do not add commentary — output only document content as Markdown.
12. Never duplicate content — each passage of text should appear exactly once.${extra}`;
}

// ── Public exports consumed by convert.ts ───────────────────────────────────

/** Pass 1: Extract document outline (TOC + heading hierarchy + page numbering scheme). */
export async function extractDocumentOutline(
  pdfBlob: Blob,
  onRetry?: (attempt: number, delaySec: number, reason?: string) => void,
  abortSignal?: AbortSignal,
  skipModels?: Set<string>,
  onModelSkip?: (skippedModel: string, nextModel: string | null, reason: string) => void,
  onModelStart?: (model: string) => void,
  onStreamProgress?: (phase: 'uploading' | 'processing' | 'streaming', charsReceived: number) => void,
  onError?: (model: string, reason: string, action: string) => void,
): Promise<ProviderResult> {
  return callWithRetry(pdfBlob, PRESCAN_PROMPT, {
    onRetry, abortSignal, skipModels, onModelSkip, onModelStart, onStreamProgress, onError,
  });
}

/** Pass 2: Convert a batch of pages to Markdown, with outline context. */
export async function convertPdfBatchToMarkdown(
  pdfBlob: Blob,
  batchNum: number,
  totalBatches: number,
  outline: string,
  onRetry?: (attempt: number, delaySec: number, reason?: string) => void,
  abortSignal?: AbortSignal,
  skipModels?: Set<string>,
  onModelSkip?: (skippedModel: string, nextModel: string | null, reason: string) => void,
  onModelStart?: (model: string) => void,
  onStreamProgress?: (phase: 'uploading' | 'processing' | 'streaming', charsReceived: number) => void,
  onError?: (model: string, reason: string, action: string) => void,
  translationLanguage?: string,
): Promise<ProviderResult> {
  const prompt = buildBatchPrompt(batchNum, totalBatches, outline, translationLanguage);
  return callWithRetry(pdfBlob, prompt, {
    onRetry, abortSignal, skipModels, onModelSkip, onModelStart, onStreamProgress, onError,
  });
}

/** Pause between batches to respect rate limits. */
export function batchDelay(): Promise<void> {
  const provider = getActiveProvider();
  return new Promise(resolve => setTimeout(resolve, provider.batchDelayMs));
}
