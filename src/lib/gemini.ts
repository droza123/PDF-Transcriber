/**
 * Thin shim that preserves the public API consumed by convert.ts.
 * The actual provider logic is in providers/gemini.ts; the retry/fallback
 * orchestration is in providers/orchestrator.ts.
 */
import { callWithRetry, callTextWithRetry, type OrchestratorCallOptions } from './providers/orchestrator';
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

function buildBatchPrompt(batchNum: number, totalBatches: number, outline: string): string {
  const settings = getSettings();
  const extra = settings.outputNotes ? `\n\nCustom instructions:\n${settings.outputNotes}` : '';

  return `Convert this PDF to Markdown optimized for AI-assisted academic citation.
This is batch ${batchNum} of ${totalBatches} from the source document.

Here is the document's structural outline for context (use this to determine correct heading levels and understand where this batch falls in the document):

${outline}

Page numbering:
- Look for printed page numbers on each page of this PDF.
- If page numbers are visible, place <!-- page: N --> at the start of each page's content, where N is the ACTUAL printed page number from the document (which may be roman numerals like "iv", or start at any number — use exactly what's printed).
- If no page numbers are visible on any page, do NOT insert page markers. Instead, ensure proper heading hierarchy so the document is navigable by section.

Layout awareness:
- Some PDFs contain scanned two-page spreads (two document pages side by side on a single PDF page). When you detect this, read LEFT page first, then RIGHT page. Do not interleave or duplicate content across the two pages. Each document page should appear exactly once in the output.

Content rules:
1. Use the heading hierarchy from the outline above to determine correct heading levels (# ## ### etc.). Match headings to the outline — do not guess levels independently.
2. If the document has a table of contents, render its entries as plain text — not as headings. Only use heading syntax for actual chapter/section titles in the body.
3. Preserve paragraph structure with blank lines between paragraphs.
4. Convert tables to Markdown table syntax.
5. Preserve footnotes using [^N] syntax with definitions at section end.
6. Preserve endnotes and bibliographic references EXACTLY as written.
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
): Promise<ProviderResult> {
  const prompt = buildBatchPrompt(batchNum, totalBatches, outline);
  return callWithRetry(pdfBlob, prompt, {
    onRetry, abortSignal, skipModels, onModelSkip, onModelStart, onStreamProgress, onError,
  });
}

/** Pause between batches to respect rate limits. */
export function batchDelay(): Promise<void> {
  const provider = getActiveProvider();
  return new Promise(resolve => setTimeout(resolve, provider.batchDelayMs));
}

// ── Markdown translation ────────────────────────────────────────────────────

const TARGET_CHUNK_WORDS = 2000;

/**
 * Split markdown into chunks on heading or paragraph boundaries.
 * Returns an array of markdown strings, each roughly TARGET_CHUNK_WORDS words.
 */
function chunkMarkdown(markdown: string): string[] {
  // Split into sections on top-level headings (# or ##)
  const sections: string[] = [];
  let current = '';
  for (const line of markdown.split('\n')) {
    if (/^#{1,2}\s/.test(line) && current.trim()) {
      sections.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current.trim()) sections.push(current);

  // Merge small sections and split large ones to hit target size
  const chunks: string[] = [];
  let buffer = '';
  for (const section of sections) {
    const bufferWords = buffer.split(/\s+/).length;
    const sectionWords = section.split(/\s+/).length;

    if (bufferWords + sectionWords <= TARGET_CHUNK_WORDS * 1.3) {
      buffer += section;
    } else {
      if (buffer.trim()) chunks.push(buffer.trim());
      // If a single section is too large, split on paragraph boundaries
      if (sectionWords > TARGET_CHUNK_WORDS * 1.3) {
        const paragraphs = section.split(/\n\n+/);
        let paraBuffer = '';
        for (const para of paragraphs) {
          if (paraBuffer.split(/\s+/).length + para.split(/\s+/).length > TARGET_CHUNK_WORDS * 1.3 && paraBuffer.trim()) {
            chunks.push(paraBuffer.trim());
            paraBuffer = '';
          }
          paraBuffer += para + '\n\n';
        }
        buffer = paraBuffer;
      } else {
        buffer = section;
      }
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim());

  return chunks.length > 0 ? chunks : [markdown];
}

function buildTranslationPrompt(chunk: string, chunkNum: number, totalChunks: number, targetLanguage: string): string {
  const settings = getSettings();
  const extra = settings.outputNotes ? `\n\nCustom instructions:\n${settings.outputNotes}` : '';

  return `Translate the following Markdown into ${targetLanguage}.
${totalChunks > 1 ? `This is chunk ${chunkNum} of ${totalChunks} from the source document.\n` : ''}
Rules:
- Preserve all Markdown formatting, heading levels, footnotes [^N], tables, page markers (<!-- page: N -->), and block quotes exactly.
- Keep bibliographic references (titles, authors, publishers, journal names) in their original language.
- Passages that are in a foreign language in the original (e.g., Greek, Latin, Hebrew quotes) should NOT be translated — preserve them exactly as written. These are intentionally in a different language.
- Output only the translated Markdown — no commentary.${extra}

---

${chunk}`;
}

export interface TranslateMarkdownOptions {
  onProgress?: (update: { currentChunk: number; totalChunks: number; statusMessage: string }) => void;
  onRetry?: (attempt: number, delaySec: number, reason?: string) => void;
  onModelSkip?: (skippedModel: string, nextModel: string | null, reason: string) => void;
  onModelStart?: (model: string) => void;
  onStreamProgress?: (phase: 'uploading' | 'processing' | 'streaming', charsReceived: number) => void;
  onError?: (model: string, reason: string, action: string) => void;
  abortSignal?: AbortSignal;
  skipModels?: Set<string>;
}

/** Translate markdown text into a target language, chunked for long documents. */
export async function translateMarkdown(
  markdown: string,
  targetLanguage: string,
  options: TranslateMarkdownOptions = {},
): Promise<string> {
  const { onProgress, onRetry, onModelSkip, onModelStart, onStreamProgress, onError, abortSignal, skipModels } = options;

  const chunks = chunkMarkdown(markdown);
  const totalChunks = chunks.length;
  const results: string[] = [];

  console.log(`[translate] Translating ${totalChunks} chunk(s) to ${targetLanguage}`);

  for (let i = 0; i < totalChunks; i++) {
    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    const chunkNum = i + 1;
    const chunkStatusMsg = `Translating chunk ${chunkNum}/${totalChunks}...`;
    onProgress?.({
      currentChunk: chunkNum,
      totalChunks,
      statusMessage: chunkStatusMsg,
    });

    const prompt = buildTranslationPrompt(chunks[i], chunkNum, totalChunks, targetLanguage);
    const result = await callTextWithRetry(prompt, {
      onRetry, onModelSkip, onStreamProgress, onError, abortSignal, skipModels,
      // Restore the chunk status message when a new model starts (clears rate-limit messages)
      onModelStart: (model) => {
        onModelStart?.(model);
        onProgress?.({ currentChunk: chunkNum, totalChunks, statusMessage: chunkStatusMsg });
      },
    });

    // Strip code fences the model may wrap output in
    let text = result.text.trim();
    if (text.startsWith('```markdown')) text = text.slice('```markdown'.length);
    else if (text.startsWith('```md')) text = text.slice('```md'.length);
    else if (text.startsWith('```')) text = text.slice(3);
    if (text.endsWith('```')) text = text.slice(0, -3);
    results.push(text.trim());

    onStreamProgress?.('streaming', 0); // reset for next chunk

    if (i < totalChunks - 1) {
      await batchDelay();
    }
  }

  console.log(`[translate] Translation complete (${totalChunks} chunks)`);
  return results.join('\n\n');
}
