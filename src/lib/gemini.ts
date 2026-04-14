/**
 * Thin shim that preserves the public API consumed by convert.ts.
 * The actual provider logic is in providers/gemini.ts; the retry/fallback
 * orchestration is in providers/orchestrator.ts.
 */
import { callWithRetry, callTextWithRetry, type OrchestratorCallOptions } from './providers/orchestrator';
import type { Provider, ProviderResult } from './providers/types';
import { getSettings } from './settings';
import { getTranscribeProvider } from './providers/registry';

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
2. A hierarchical table of contents using Markdown headings to show the FULL nesting depth. Use up to six levels (# through ######) as needed to capture the document's actual structure:
   # Part / major division                (e.g., "Part One", "§1")
   ## Chapter / section                   (e.g., "Chapter 3", "A.", "Commentary on Matthew 1")
   ### Subsection                         (e.g., "1.", "I.", "Introduction", "Text")
   #### Sub-subsection                    (e.g., "1.1", "a.", "Historical Context")
   ##### Sub-sub-subsection               (e.g., "1.1.1", "i.")
   ###### Deepest level                   (rarely needed; use only for genuine 6th-level nesting)
   Include the page number (as printed in the document) next to each heading if visible.

Source of truth:
- If the document has a printed Table of Contents, prefer it as the hierarchy source — its indentation and numbering tell you the correct nesting depth.
- Verify the TOC against headings visible in the body; if they disagree, trust the body's actual typography (larger/bolder = higher level).
- For scholarly commentaries (Bible, classical texts, law), expect deep nesting: a chapter may contain several numbered sections, each with lettered subsections, each with numbered sub-points. Capture this faithfully — do not flatten.

Output ONLY the outline — no content, no commentary.`;

function buildBatchPrompt(
  batchNum: number,
  totalBatches: number,
  outline: string,
  previousBatchHeadings: string = '',
): string {
  const settings = getSettings();
  const extra = settings.outputNotes ? `\n\nCustom instructions:\n${settings.outputNotes}` : '';

  const prevBlock = previousBatchHeadings.trim()
    ? `

Previous batch context (headings already emitted in the previous batch, most recent last):

${previousBatchHeadings}

DO NOT repeat these headings. If the current batch begins mid-section (i.e., the first pages continue content under one of the headings above), do NOT re-emit that section's title — continue the content directly. Only emit a heading when you cross into a NEW section not listed above.`
    : '';

  return `Convert this PDF to Markdown optimized for AI-assisted academic citation.
This is batch ${batchNum} of ${totalBatches} from the source document.

Here is the document's structural outline for context (use this to determine correct heading levels and understand where this batch falls in the document):

${outline}${prevBlock}

Page numbering:
- Look for printed page numbers on each page of this PDF.
- If page numbers are visible, place <!-- page: N --> at the start of each page's content, where N is the ACTUAL printed page number from the document (which may be roman numerals like "iv", or start at any number — use exactly what's printed).
- If no page numbers are visible on any page, do NOT insert page markers. Instead, ensure proper heading hierarchy so the document is navigable by section.

Layout awareness:
- Some PDFs contain scanned two-page spreads (two document pages side by side on a single PDF page). When you detect this, read LEFT page first, then RIGHT page. Do not interleave or duplicate content across the two pages. Each document page should appear exactly once in the output.

Running headers / page headers:
- PDFs typically have a running header at the top (and/or bottom) of each page — a shortened book title, chapter name, author surname, or section title repeated on every page. These are visual navigation aids, NOT structural headings.
- Do NOT emit running headers as Markdown headings. You can recognize them by repetition: if the same short line appears at the top of many consecutive pages, it is a running header — omit it entirely.
- Only emit a heading when it is a genuine, one-time section title in the flow of the text (typically typeset larger, bolder, or on its own line with spacing around it).

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

/**
 * Extract the last N markdown headings from a batch's output, to feed forward as
 * context for the next batch's prompt (A1 — previous-batch heading awareness).
 * Returns the headings as-is, each on its own line, or '' if none found.
 */
export function extractTrailingHeadings(markdown: string, count = 5): string {
  const matches: string[] = [];
  for (const line of markdown.split('\n')) {
    if (/^(#{1,6})\s+\S/.test(line)) {
      matches.push(line.trim());
    }
  }
  return matches.slice(-count).join('\n');
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
  provider?: Provider,
  models?: string[],
): Promise<ProviderResult> {
  return callWithRetry(pdfBlob, PRESCAN_PROMPT, {
    provider, models, onRetry, abortSignal, skipModels, onModelSkip, onModelStart, onStreamProgress, onError,
  });
}

/** Pass 2: Convert a batch of pages to Markdown, with outline context. */
export async function convertPdfBatchToMarkdown(
  pdfBlob: Blob,
  batchNum: number,
  totalBatches: number,
  outline: string,
  previousBatchHeadings: string = '',
  onRetry?: (attempt: number, delaySec: number, reason?: string) => void,
  abortSignal?: AbortSignal,
  skipModels?: Set<string>,
  onModelSkip?: (skippedModel: string, nextModel: string | null, reason: string) => void,
  onModelStart?: (model: string) => void,
  onStreamProgress?: (phase: 'uploading' | 'processing' | 'streaming', charsReceived: number) => void,
  onError?: (model: string, reason: string, action: string) => void,
  provider?: Provider,
  models?: string[],
): Promise<ProviderResult> {
  const prompt = buildBatchPrompt(batchNum, totalBatches, outline, previousBatchHeadings);
  return callWithRetry(pdfBlob, prompt, {
    provider, models, onRetry, abortSignal, skipModels, onModelSkip, onModelStart, onStreamProgress, onError,
  });
}

/**
 * Send OCR-extracted headings to a chat model for level correction.
 * Returns the corrected outline string, or the original if correction fails.
 */
export async function correctOcrHeadings(
  ocrMarkdown: string,
  options: {
    onRetry?: (attempt: number, delaySec: number, reason?: string) => void;
    abortSignal?: AbortSignal;
    skipModels?: Set<string>;
    onModelSkip?: (skippedModel: string, nextModel: string | null, reason: string) => void;
    onModelStart?: (model: string) => void;
    onStreamProgress?: (phase: 'uploading' | 'processing' | 'streaming', charsReceived: number) => void;
    onError?: (model: string, reason: string, action: string) => void;
  } = {},
): Promise<{ outline: string; correctedMarkdown: string }> {
  // Extract heading lines from OCR output
  const headingLines: { line: string; text: string }[] = [];
  for (const line of ocrMarkdown.split('\n')) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) headingLines.push({ line: line.trim(), text: m[2].trim() });
  }

  if (headingLines.length === 0) {
    return { outline: '', correctedMarkdown: ocrMarkdown };
  }

  const headingList = headingLines.map(h => h.line).join('\n');

  const prompt = `The following is a list of headings extracted from a document by OCR. The heading levels (# through ######) may be incorrect because the OCR model guessed them from visual appearance rather than logical structure.

Correct the heading levels to reflect the document's actual hierarchy:
- # for the top-level divisions (Parts, major sections, book title)
- ## for chapters or primary sections
- ### for subsections
- #### and deeper for sub-subsections
- Use contextual clues: numbering patterns (1, 1.1, 1.1.1), "Part/Chapter/Section" labels, indentation in numbering
- Return ONLY the corrected heading lines, one per line, in the same order
- Do not add, remove, or reword any headings — keep the text exactly as-is, only change the # level

Headings:
${headingList}`;

  try {
    const result = await callTextWithRetry(prompt, options);
    const correctedLines = result.text.trim().split('\n')
      .map(l => l.trim())
      .filter(l => /^#{1,6}\s+/.test(l));

    // Build mapping: original heading text → corrected # prefix
    // Match by position (order preserved) rather than text to handle duplicates
    let correctedMarkdown = ocrMarkdown;
    const outline: string[] = [];
    const count = Math.min(headingLines.length, correctedLines.length);
    for (let i = 0; i < count; i++) {
      const original = headingLines[i].line;
      const corrected = correctedLines[i];
      outline.push(corrected);
      if (original !== corrected) {
        // Replace first occurrence of this exact line that hasn't been replaced yet
        correctedMarkdown = correctedMarkdown.replace(original, corrected);
      }
    }
    // Include any headings that weren't in the corrected list (beyond count)
    for (let i = count; i < headingLines.length; i++) {
      outline.push(headingLines[i].line);
    }

    console.log(`[heading-correction] Corrected ${count} heading(s) via LLM`);
    return { outline: outline.join('\n'), correctedMarkdown };
  } catch (e: any) {
    console.warn(`[heading-correction] LLM correction failed, using original headings: ${e.message}`);
    return { outline: headingList, correctedMarkdown: ocrMarkdown };
  }
}

/** Pause between batches to respect rate limits. */
export function batchDelay(provider?: Provider): Promise<void> {
  const prov = provider ?? getTranscribeProvider();
  return new Promise(resolve => setTimeout(resolve, prov.batchDelayMs));
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
  /** Explicit provider for translation (overrides active). */
  provider?: Provider;
  /** Explicit model list for translation (overrides active). */
  models?: string[];
  onProgress?: (update: { currentChunk: number; totalChunks: number; statusMessage: string }) => void;
  /** Called after each chunk completes, with all results so far. Use for persistence. */
  onChunkComplete?: (completedChunks: number, totalChunks: number, results: string[]) => void;
  /** Number of chunks already completed (for resume). Skips those chunks. */
  resumeFromChunk?: number;
  /** Previously completed chunk results (for resume). */
  resumeResults?: string[];
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
  const { provider, models, onProgress, onChunkComplete, resumeFromChunk, resumeResults, onRetry, onModelSkip, onModelStart, onStreamProgress, onError, abortSignal, skipModels } = options;

  const chunks = chunkMarkdown(markdown);
  const totalChunks = chunks.length;
  const results: string[] = resumeResults ? [...resumeResults] : [];
  const startChunk = resumeFromChunk ?? 0;

  console.log(`[translate] Translating ${totalChunks} chunk(s) to ${targetLanguage}${startChunk > 0 ? ` (resuming from chunk ${startChunk + 1})` : ''}`);

  for (let i = startChunk; i < totalChunks; i++) {
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
      provider, models, onRetry, onModelSkip, onStreamProgress, onError, abortSignal, skipModels,
      onModelStart: (mdl) => {
        onModelStart?.(mdl);
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

    // Persist progress after each chunk
    onChunkComplete?.(chunkNum, totalChunks, results);

    onStreamProgress?.('streaming', 0);

    if (i < totalChunks - 1) {
      await batchDelay();
    }
  }

  console.log(`[translate] Translation complete (${totalChunks} chunks)`);
  return results.join('\n\n');
}
