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

Report only the structure that genuinely exists — never invent it:
- Include a heading ONLY for a division that is actually marked in the document: an entry in a printed Table of Contents, or a title set off by distinct typography (larger/bolder type, its own line with surrounding space) or explicit numbering/labels (e.g. "Chapter 3", "1.1", "§2", "Part Two").
- Do NOT derive a hierarchy from the document's topics, themes, or paragraph breaks. Topic shifts within continuous prose are NOT headings.
- If the document has no printed Table of Contents and no visually-distinct section titles — whether it is continuous prose (a letter, essay, article, or narrative) or other unstructured content (a poem, a list, a form, or a single block of text) — it has no explicit structure. In that case, state plainly that the document has no explicit structural divisions and return an empty (or minimal) table of contents. Reporting "no structure" is the correct, expected answer for such documents — do not manufacture sections to fill the outline.

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
1. Use the heading hierarchy from the outline above to determine correct heading levels (# ## ### etc.). Match headings to the outline — do not guess levels independently. If the outline is empty or indicates no structure, follow the Structural fidelity guidance above and emit no headings.
2. If the document has a table of contents, render its entries as plain text — not as headings. Only use heading syntax for actual chapter/section titles in the body.
3. Preserve paragraph structure with blank lines between paragraphs.
4. Convert tables to Markdown table syntax.
5. Preserve footnotes using [^N] syntax. Use the footnote's ACTUAL printed number as the label — a note printed as "33" becomes [^33], not [^1] — and do NOT renumber from 1. Keep each definition at the end of the section (or batch) in which its note appears, written as [^33]: ....
6. Preserve endnotes and bibliographic references EXACTLY as written.
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

/**
 * LLM-assisted heading correction: sends the OCR heading list + prescan outline
 * to a chat model for structured correction (keep/demote/merge actions).
 * Falls back to simple text-match remapping on failure.
 */
export async function correctOcrHeadingsWithLlm(
  ocrMarkdown: string,
  outline: string,
  options: {
    provider?: Provider;
    models?: string[];
    abortSignal?: AbortSignal;
    skipModels?: Set<string>;
    onModelSkip?: (skippedModel: string, nextModel: string | null, reason: string) => void;
    onModelStart?: (model: string) => void;
    onStreamProgress?: (phase: 'uploading' | 'processing' | 'streaming', charsReceived: number) => void;
    onError?: (model: string, reason: string, action: string) => void;
  } = {},
): Promise<{ correctedMarkdown: string; stats: { kept: number; demoted: number; merged: number; total: number } }> {
  const lines = ocrMarkdown.split('\n');

  // Extract heading lines with their 1-based line numbers
  const headings: { lineNum: number; level: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (m) headings.push({ lineNum: i + 1, level: m[1].length, text: m[2] });
  }

  if (headings.length === 0) {
    return { correctedMarkdown: ocrMarkdown, stats: { kept: 0, demoted: 0, merged: 0, total: 0 } };
  }

  const headingList = headings.map(h => `Line ${h.lineNum}: ${'#'.repeat(h.level)} ${h.text}`).join('\n');

  const prompt = `You are correcting heading levels in an OCR-extracted document. You have two inputs:

1. STRUCTURAL OUTLINE (from a separate prescan — this is the authoritative structure):
${outline}

2. OCR HEADING LINES (with line numbers — these need correction):
${headingList}

For EACH OCR heading line above, output exactly ONE line in this pipe-delimited format:
LINE_NUMBER|ACTION|LEVEL|CORRECTED_TEXT

Where:
- LINE_NUMBER: the line number from the OCR list
- ACTION: one of:
  - "keep" — this is a real heading, correct its level
  - "demote" — this should NOT be a heading (e.g., "CHAPTER 2", "ZOOM OUT", "Question:", "Our answer:", figure captions). It will be converted to bold text.
  - "merge_up" — this line is the continuation of a heading that was split across two lines by OCR. Its text will be appended to the previous heading.
- LEVEL: the correct heading level (1-6) if ACTION is "keep", or 0 otherwise
- CORRECTED_TEXT: the heading text (keep original wording but you may fix case to Title Case if appropriate), or empty if demoted/merged

Rules:
- Match OCR headings to the outline to determine correct levels.
- Book/document title → level 1
- Parts (Part One, Part Two) → level 1
- Chapters → level 2
- Sections within chapters → level 3
- Subsections → level 4, sub-subsections → level 5, etc.
- "CHAPTER N" markers, "ZOOM OUT" headers, "Question:", "Our answer:", "Questions:", "Our answers:" → demote
- Figure captions → demote
- If the STRUCTURAL OUTLINE reports that the document has no explicit structure (it is empty/minimal, or describes unstructured content such as a letter, essay, article, narrative, poem, list, or form), the document genuinely has no sections: "demote" every OCR heading that is not an unmistakable, source-marked section title. The OCR model guessed those headings from visual appearance — do NOT keep or infer headings to impose structure the source lacks.
- Otherwise (the outline describes a real structure): if an OCR heading is not listed in the outline but is clearly a genuine section title, infer its level from context.
- Output ONLY the pipe-delimited lines, no other text.`;

  try {
    const result = await callTextWithRetry(prompt, options);

    // Parse the structured response
    const corrections = new Map<number, { action: string; level: number; text: string }>();
    for (const line of result.text.split('\n')) {
      const parts = line.trim().split('|');
      if (parts.length >= 3) {
        const lineNum = parseInt(parts[0], 10);
        const action = parts[1]?.trim().toLowerCase();
        const level = parseInt(parts[2], 10);
        const text = parts.slice(3).join('|').trim();
        if (!isNaN(lineNum) && (action === 'keep' || action === 'demote' || action === 'merge_up')) {
          corrections.set(lineNum, { action, level: isNaN(level) ? 0 : level, text });
        }
      }
    }

    // Apply corrections
    let kept = 0, demoted = 0, merged = 0;
    const resultLines = [...lines];
    let mergeIntoNext = '';

    for (let i = 0; i < resultLines.length; i++) {
      const lineNum = i + 1;
      const correction = corrections.get(lineNum);
      if (!correction) {
        // If we have pending merge text and this is a heading, prepend it
        if (mergeIntoNext && /^#{1,6}\s+/.test(resultLines[i])) {
          const hm = resultLines[i].match(/^(#{1,6})\s+(.+)$/);
          if (hm) {
            resultLines[i] = `${hm[1]} ${mergeIntoNext} ${hm[2]}`;
            mergeIntoNext = '';
          }
        }
        continue;
      }

      const hm = resultLines[i].match(/^(#{1,6})\s+(.+)$/);
      if (!hm) continue;

      switch (correction.action) {
        case 'keep':
          if (correction.level >= 1 && correction.level <= 6) {
            const text = correction.text || hm[2];
            resultLines[i] = '#'.repeat(correction.level) + ' ' + text;
            kept++;
          }
          // Apply any pending merge
          if (mergeIntoNext) {
            resultLines[i] = resultLines[i].replace(/^(#{1,6})\s+/, `$1 ${mergeIntoNext} `);
            mergeIntoNext = '';
          }
          break;
        case 'demote':
          resultLines[i] = `**${hm[2]}**`;
          demoted++;
          break;
        case 'merge_up':
          mergeIntoNext = hm[2];
          resultLines[i] = ''; // remove the split line
          merged++;
          break;
      }
    }

    console.log(`[heading-llm] Applied: ${kept} kept, ${demoted} demoted, ${merged} merged (${corrections.size} instructions from LLM)`);
    return {
      correctedMarkdown: resultLines.join('\n'),
      stats: { kept, demoted, merged, total: headings.length },
    };
  } catch (e: any) {
    console.warn(`[heading-llm] LLM correction failed, falling back to simple remap: ${e.message}`);
    // Fall back to simple text matching
    return {
      correctedMarkdown: ocrMarkdown,
      stats: { kept: 0, demoted: 0, merged: 0, total: headings.length },
    };
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
