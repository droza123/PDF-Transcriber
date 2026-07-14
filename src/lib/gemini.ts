/**
 * Thin shim that preserves the public API consumed by convert.ts.
 * The actual provider logic is in providers/gemini.ts; the retry/fallback
 * orchestration is in providers/orchestrator.ts.
 */
import { callWithRetry, callTextWithRetry, type OrchestratorCallOptions } from './providers/orchestrator';
import type { Provider, ProviderResult } from './providers/types';
import { getSettings } from './settings';
import { getTranscribeProvider } from './providers/registry';
import { collectHeadings, serializeHeading } from './headings';

// Re-export types for backward compat
export type GeminiCallOptions = OrchestratorCallOptions;
export type GeminiResult = ProviderResult;

/** Dynamic batch size from settings. */
export function getBatchSize(): number {
  return getSettings().batchSize;
}

// ── Prompts (provider-agnostic, stay here) ──────────────────────────────────

const PRESCAN_PROMPT = `Analyze this PDF document and produce a structural outline in Markdown.

First, classify how the document handles reference notes by outputting a single line in EXACTLY this form (this must be the very first line of your output):
NOTE STYLE: <footnotes|endnotes|none>
- footnotes: numbered notes printed at the BOTTOM of the same page where their reference number appears.
- endnotes: numbered notes gathered in a separate "Notes" section at the end of each chapter or the end of the book, away from the small reference numbers in the body text.
- none: the document has no numbered reference notes.

Then include:

1. The document's page numbering scheme (e.g., "roman numerals i-xii for front matter, then arabic 1-234 for body", or "no page numbers visible").
2. A hierarchical table of contents using up to nine levels as needed to capture the document's FULL nesting depth:
   # through ###### represent levels 1 through 6 normally.
   For levels 7 through 9, NEVER use seven or more opening # characters. Use an H6 fallback preceded immediately by a metadata comment, exactly like this:
   <!-- heading-level: 7 -->
   ###### Seventh-level title
   <!-- heading-level: 8 -->
   ###### Eighth-level title
   <!-- heading-level: 9 -->
   ###### Ninth-level title
   Include the page number (as printed in the document) in the heading text if visible. Use levels 7-9 only when the source genuinely contains that depth.

Source of truth:
- If the document has a printed Table of Contents, prefer it as the hierarchy source — its indentation and numbering tell you the correct nesting depth.
- Verify the TOC against headings visible in the body; if they disagree, trust the body's actual typography (larger/bolder = higher level).
- A printed TOC may be abbreviated (e.g. chapters only). Also include genuine section titles visible in the body that the printed TOC omits, at the level their typography and numbering indicate — the outline should be MORE complete than an abbreviated printed TOC, never less.
- Include front matter and back matter divisions (Preface, Acknowledgments, Abbreviations, Introduction, Conclusion, Appendices, Bibliography, Indexes) at their appropriate level — usually the same level as chapters or parts.
- Do NOT mistake running headers/footers for section titles: a short line repeated at the top or bottom of many consecutive pages (book title, chapter name, author surname) is a navigation aid, not a heading. A genuine section title appears ONCE, at the point where its section begins.
- For scholarly commentaries (Bible, classical texts, law), expect deep nesting: a chapter may contain several numbered sections, each with lettered subsections, each with numbered sub-points. Capture this faithfully — do not flatten.
- Small inline labels that merely mark list items within a paragraph or argument (e.g. "a)", "b)", "c)") are usually NOT TOC-level headings — include them only when the source typography clearly sets them off as section titles.

Report only the structure that genuinely exists — never invent it:
- Include a heading ONLY for a division that is actually marked in the document: an entry in a printed Table of Contents, or a title set off by distinct typography (larger/bolder type, its own line with surrounding space) or explicit numbering/labels (e.g. "Chapter 3", "1.1", "§2", "Part Two").
- Do NOT derive a hierarchy from the document's topics, themes, or paragraph breaks. Topic shifts within continuous prose are NOT headings.
- If the document has no printed Table of Contents and no visually-distinct section titles — whether it is continuous prose (a letter, essay, article, or narrative) or other unstructured content (a poem, a list, a form, or a single block of text) — it has no explicit structure. In that case, state plainly that the document has no explicit structural divisions and return an empty (or minimal) table of contents. Reporting "no structure" is the correct, expected answer for such documents — do not manufacture sections to fill the outline.

Output ONLY the outline — no content, no commentary.`;

export type NoteStyle = 'footnotes' | 'endnotes' | 'none' | 'unknown';

/**
 * Read the NOTE STYLE classification the prescan emits at the top of the outline.
 * Returns 'unknown' when absent so callers fall back to the default (footnote)
 * behavior — never a regression for documents scanned before this field existed.
 */
export function parseNoteStyle(outline: string): NoteStyle {
  const m = outline.match(/^\s*NOTE STYLE:\s*(footnotes|endnotes|none)\b/im);
  return (m ? m[1].toLowerCase() : 'unknown') as NoteStyle;
}

function buildBatchPrompt(
  batchNum: number,
  totalBatches: number,
  outline: string,
  previousBatchHeadings: string = '',
): string {
  const settings = getSettings();
  const extra = settings.outputNotes ? `\n\nCustom instructions:\n${settings.outputNotes}` : '';

  // Reference-note handling depends on the prescan's NOTE STYLE classification.
  // For endnote documents the note text is NOT on the page with its reference,
  // so the model must emit bare [^N] anchors (printed number, may reset per
  // chapter) and never fabricate placeholder definitions; the Notes section is
  // transcribed as ordinary numbered text so it stays back-matter (endnotes stay
  // endnotes, page numbers intact). Otherwise we keep the original footnote rules.
  const noteRules = parseNoteStyle(outline) === 'endnotes'
    ? `5. This document uses ENDNOTES: the note text is gathered in a separate "Notes" section, not on the same page as the reference. In the body, mark each note reference with [^N] using its ACTUAL printed number (a reference printed as "33" becomes [^33]). The numbering may restart at 1 in each chapter — that is fine, always use the printed number. On body pages do NOT write any note definition, and NEVER invent placeholder text such as "[footnote text not available]"; the note text is simply not on these pages.
6. When the pages in this batch ARE part of the Notes/Endnotes section, write each note as a definition line "[^N]: note text" using its printed number (e.g. "[^33]: ..."), and keep the section's headings (e.g. "Notes", "Chapter 5"). Preserve page markers and bibliographic references exactly as written.`
    : `5. Preserve footnotes using [^N] syntax. Use the footnote's ACTUAL printed number — a note printed as "33" becomes [^33], not [^1] — and do NOT renumber from 1. Keep each definition at the end of the section (or batch) in which its note appears, written as [^33]: ....
6. Preserve endnotes and bibliographic references EXACTLY as written.`;

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
- Place each <!-- page: N --> marker on its own line. When a page break falls in the middle of a paragraph, insert the marker at the exact point where the new page begins and continue the paragraph immediately after it — do NOT slide the marker to the nearest paragraph break, as that misattributes text to the wrong page.
- If no page numbers are visible on any page, do NOT insert page markers. Rely on the document's genuine heading hierarchy for navigation where it has one; if the document has no explicit structure, transcribe it as-is (see Structural fidelity below) and do NOT add headings to compensate for the missing page numbers.

Layout awareness:
- Some PDFs contain scanned two-page spreads (two document pages side by side on a single PDF page). When you detect this, read LEFT page first, then RIGHT page. Do not interleave or duplicate content across the two pages. Each document page should appear exactly once in the output.
- For pages laid out in multiple columns, read each column in full in reading order (the entire left column top-to-bottom, then the right) — do not read across columns or interleave their lines.

Running headers / footers:
- PDFs typically have a running header at the top and/or a running footer at the bottom of each page — a shortened book title, chapter name, author surname, section title, or page number repeated on every page. These are visual navigation aids, NOT structural headings or body content.
- Do NOT emit running headers or footers as Markdown headings or as body text. Recognize them by repetition: if the same short line appears at the top, or the same short line or page number appears at the bottom, across many consecutive pages, it is a running element — omit it entirely. (Exception: a printed page number in the header or footer should still be captured in the <!-- page: N --> marker per Page numbering above; only the repeated title/label text is dropped.)
- Only emit a heading when it is a genuine, one-time section title in the flow of the text (typically typeset larger, bolder, or on its own line with spacing around it).

Structural fidelity:
- Reproduce only the structure that genuinely exists in the source. Emit a Markdown heading ONLY for a real section title — one set off by distinct typography (larger/bolder type, its own line) or explicit numbering/labels (e.g. "Chapter 3", "1.1", "§2", "Part Two") — and matched to the outline above.
- Do NOT invent headings to organize the content by topic or paragraph. A shift in subject within continuous prose is not a heading.
- If the outline indicates the document has little or no explicit structure (e.g. a letter, an essay, an article, an unbroken narrative, a poem, a list, or a form), transcribe the content exactly as it appears — preserving its original form and order, whatever that is (running paragraphs, verse lines, list items, dialogue, tabular data, or a single block of text) — and emit NO headings. Producing zero headings is the correct outcome for an unstructured document: render the document as it is and do not add structure the source lacks.

Content rules:
1. Use the heading hierarchy from the outline above to determine correct heading levels. Match headings to the outline — do not guess levels independently. For levels 7-9, preserve the outline's exact two-line <!-- heading-level: N --> plus ###### fallback syntax. Never emit seven or more opening # characters. If the outline is empty or indicates no structure, follow the Structural fidelity guidance above and emit no headings.
2. If the document has a table of contents, render its entries as plain text — not as headings. Only use heading syntax for actual chapter/section titles in the body.
3. Preserve paragraph structure with blank lines between paragraphs.
4. Convert tables to Markdown table syntax.
${noteRules}
7. Transcribe passages in non-Latin scripts (Greek, Hebrew, Syriac, etc.) and other original-language quotations exactly as printed — do not transliterate, translate, or normalize them.
8. Describe figures/images in [brackets], e.g. [Figure 3: Bar chart of enrollment].
9. Fix hyphenation artifacts from PDF line-breaking.
10. Preserve block quotes using > syntax.
11. Preserve numbered and bulleted lists exactly.
12. Do not add commentary — output only document content as Markdown.
13. Never duplicate content — each passage of text should appear exactly once.${extra}`;
}

/**
 * Extract the last N markdown headings from a batch's output, to feed forward as
 * context for the next batch's prompt (A1 — previous-batch heading awareness).
 * Returns the headings as-is, each on its own line, or '' if none found.
 */
export function extractTrailingHeadings(markdown: string, count = 5): string {
  return collectHeadings(markdown)
    .slice(-count)
    .map(heading => serializeHeading(heading.level, heading.text))
    .join('\n');
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
- Preserve all Markdown formatting, heading levels, footnotes [^N], tables, page markers (<!-- page: N -->), heading-level metadata comments (<!-- heading-level: 7 --> through 9), and block quotes exactly.
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
