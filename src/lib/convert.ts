import type { ConversionJob, PartialProgress } from '../types';
import { getPdfPageCount, extractPdfPageRange } from './pdfUtils';
import { addSessionSkippedModel, getSettings, getScanModelPriority, getTranscribeModelPriority } from './settings';
import {
  getBatchSize,
  extractDocumentOutline,
  convertPdfBatchToMarkdown,
  batchDelay,
  extractTrailingHeadings,
  correctOcrHeadingsWithLlm,
  parseNoteStyle,
} from './gemini';
import { cleanHeadings } from './headingCleanup';
import { getScanProvider, getTranscribeProvider } from './providers/registry';

type ProgressCallback = (update: Partial<ConversionJob>) => void;

export interface ConvertFileOptions {
  file: File;
  jobId: string;
  sourcePath: string;
  onProgress: ProgressCallback;
  /**
   * Called after each successful batch. May return a Promise — convert.ts
   * awaits this so the persistence write lands before the next batch starts.
   * This is what makes the retry-after-failure path actually resume: if a
   * failure happens in the very next batch, the prior batch's progress is
   * guaranteed to be on disk.
   */
  onBatchComplete: (progress: PartialProgress) => void | Promise<void>;
  resumeFrom?: PartialProgress;
  abortSignal?: AbortSignal;
}

/** Strip markdown code fences that Gemini sometimes wraps output in. */
function stripCodeFences(text: string): string {
  let s = text.trim();
  if (s.startsWith('```markdown')) {
    s = s.slice('```markdown'.length);
  } else if (s.startsWith('```md')) {
    s = s.slice('```md'.length);
  } else if (s.startsWith('```')) {
    s = s.slice(3);
  }
  if (s.endsWith('```')) {
    s = s.slice(0, -3);
  }
  return s.trim();
}

/** Collapse 3+ consecutive newlines to 2. */
function normalizeBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Parse headings from a prescan outline, supporting both formats:
 * - Markdown headings: `## Title`
 * - Indented bullet lists: `  - 1. Title (page)`
 * Returns a map of normalized heading text → heading level (1-6).
 */
function parseOutlineHeadings(outline: string): Map<string, number> {
  const levelMap = new Map<string, number>();

  for (const line of outline.split('\n')) {
    // Format 1: Markdown headings (# through ######)
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      const key = normalizeHeadingText(hm[2]);
      if (!levelMap.has(key)) levelMap.set(key, hm[1].length);
      continue;
    }

    // Format 2: Indented bullet list (- or * with leading spaces)
    const lm = line.match(/^(\s*)[*-]\s+(.+)$/);
    if (lm) {
      const indent = lm[1].length;
      const level = Math.min(6, Math.floor(indent / 2) + 1);
      const key = normalizeHeadingText(lm[2]);
      if (!levelMap.has(key)) levelMap.set(key, level);
    }
  }

  return levelMap;
}

/**
 * Remap heading levels in OCR markdown to match a prescan outline.
 * Builds a map of normalized heading text → correct level from the outline,
 * then replaces heading prefixes in the markdown.
 */
function remapHeadingsFromOutline(markdown: string, outline: string): { text: string; remapped: number; outlineSize: number } {
  const levelMap = parseOutlineHeadings(outline);

  if (levelMap.size === 0) return { text: markdown, remapped: 0, outlineSize: 0 };

  let remapped = 0;
  const text = markdown.split('\n').map(line => {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (!m) return line;
    const key = normalizeHeadingText(m[2]);
    const correctLevel = levelMap.get(key);
    if (correctLevel != null && correctLevel !== m[1].length) {
      remapped++;
      return '#'.repeat(correctLevel) + ' ' + m[2];
    }
    return line;
  }).join('\n');

  return { text, remapped, outlineSize: levelMap.size };
}

/**
 * Normalize heading text for fuzzy matching:
 * - Lowercase, collapse whitespace
 * - Strip trailing page numbers: (3), (v), (xi-xvi)
 * - Strip leading chapter/section numbers: 1., 1.1, A.
 * - Strip markdown bold markers: **text**
 */
function normalizeHeadingText(text: string): string {
  return text
    .trim()
    .replace(/\*\*/g, '')                          // strip bold markers
    .replace(/\s*\([ivxlcdm\d\s,–-]+\)\s*$/i, '') // strip trailing page numbers
    .replace(/^\d+(\.\d+)*\.?\s+/, '')             // strip leading "1.", "1.1", "1.1.1"
    .replace(/^[A-Z]\.?\s+/, '')                   // strip leading "A.", "B "
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/** Build YAML frontmatter from file metadata. */
function buildFrontmatter(fileName: string, totalPages: number, noteStyle?: string, notesPosition?: string): string {
  const title = fileName
    .replace(/\.pdf$/i, '')
    .replace(/_/g, ' ')
    .replace(/ - /g, ' \u2014 ')
    .replace(/\s+/g, ' ')
    .trim();
  const date = new Date().toISOString().split('T')[0];
  const { scanProvider, transcribeProvider } = getSettings();
  const transcribeModels = getTranscribeModelPriority();
  const provider = transcribeProvider;
  const model = transcribeModels[0] ?? '';
  const scanInfo = scanProvider !== transcribeProvider ? `\nscan_provider: "${scanProvider}"` : '';
  // Flag endnote documents so the DOCX exporters render the [^N] notes as native
  // Word endnotes (rather than page-bottom footnotes). The Markdown file keeps the
  // [^N] references + [^N]: definitions with their printed numbers either way.
  // `notes_position` controls where Word collects the endnotes: "section-end"
  // (end of each chapter — the default for per-chapter numbering) or "document-end"
  // (the very back — default for continuous numbering). Edit it to adjust per book.
  const notesInfo = noteStyle === 'endnotes'
    ? `\nnotes: "endnotes"${notesPosition ? `\nnotes_position: "${notesPosition}"` : ''}`
    : '';
  return `---
title: "${title}"
source_file: "${fileName}"
pages: ${totalPages}
converted: "${date}"
converter: "PDF Transcriber"
provider: "${provider}"
model: "${model}"${scanInfo}${notesInfo}
---`;
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Ensure footnote definition labels are unique across batches. The transcribe
 * prompt preserves each note's printed number as its [^N] label; if a document
 * restarts footnote numbering partway through, two batches can each define [^1]
 * — invalid Markdown that silently drops a note. For any label already defined
 * in an earlier batch, rename every occurrence (reference AND definition) in the
 * later batch to a unique, \w-safe variant (`1` → `1_2`), since the DOCX
 * exporters parse footnote labels with \w+. Returns the (possibly modified)
 * batches and the number of labels renamed. No-op when labels are already unique
 * (continuous or gapped-but-unique numbering).
 */
function dedupeFootnoteLabels(batches: string[]): { results: string[]; renamed: number } {
  const used = new Set<string>();
  let renamed = 0;

  const out = batches.map(batch => {
    // Labels DEFINED in this batch (definition lines `[^label]: ...`), in order.
    const defs: string[] = [];
    const defRe = /^\[\^([^\]]+)\]:/gm;
    let m: RegExpExecArray | null;
    while ((m = defRe.exec(batch)) !== null) {
      if (!defs.includes(m[1])) defs.push(m[1]);
    }

    let text = batch;
    for (const label of defs) {
      if (!used.has(label)) {
        used.add(label);
        continue;
      }
      // Collision with an earlier batch — find a unique \w-safe replacement.
      let n = 2;
      let next = `${label}_${n}`;
      while (used.has(next) || defs.includes(next)) {
        n++;
        next = `${label}_${n}`;
      }
      // Replace both `[^label]` references and `[^label]:` definitions. The token
      // is delimited by `[^` and `]`, so an exact-label match never catches a
      // longer label (e.g. `[^1]` does not match inside `[^12]`).
      text = text.replace(new RegExp(`\\[\\^${escapeRegExp(label)}\\]`, 'g'), `[^${next}]`);
      used.add(next);
      renamed++;
    }
    return text;
  });

  return { results: out, renamed };
}

/**
 * Remove fabricated placeholder footnote definitions — junk the model emits for
 * endnote documents when it sees a reference number but the note text is not on
 * the visible pages. Two shapes occur:
 *   • a "missing/omitted/not available" phrase — e.g. "[^5]: [footnote text not
 *     available in visible pages]", "[^8]: [Footnote content omitted in source]";
 *   • a bare number echo — e.g. "[^98]: [Endnote 98]" (also "[Footnote N]"/"[Note N]").
 * Only a definition whose ENTIRE body is such a bracketed stand-in is removed — a
 * real note is never just that — so this is safe to run in every mode. Besides being
 * junk, an echo block dropped mid-body would otherwise form a phantom numbering-reset
 * group that shifts the DOCX exporter's per-chapter endnote linking by one chapter.
 */
function stripPlaceholderFootnoteDefs(batches: string[]): { results: string[]; removed: number } {
  const missingRe = /^\[\^\w+\]:\s*\[[^\]]*\b(?:omitted|missing|unavailable|not\s+(?:available|visible|shown|present|provided|included))\b[^\]]*\]\s*$/i;
  const echoRe = /^\[\^\w+\]:\s*\[\s*(?:end|foot)?note\s*\d*\s*\]\s*$/i;
  let removed = 0;
  const out = batches.map(batch =>
    batch.split('\n').filter(line => {
      const t = line.trim();
      if (missingRe.test(t) || echoRe.test(t)) { removed++; return false; }
      return true;
    }).join('\n'),
  );
  return { results: out, removed };
}

/** Convert a single PDF file to Markdown, with optional resume and cancel support. */
export async function convertFile(options: ConvertFileOptions): Promise<string> {
  const { file, jobId, sourcePath, onProgress, onBatchComplete, resumeFrom, abortSignal } = options;
  const BATCH_SIZE = getBatchSize();

  // In-memory set of models to skip — accumulates across batches within this job only.
  // Never persisted; garbage-collected when the job finishes. Intentionally shared
  // across scan and transcribe even when their stage model lists differ: skips are
  // keyed by model id, and a model that fails in one stage will fail in the other.
  const skipModels = new Set<string>();

  const onModelSkip = (skippedModel: string, nextModel: string | null, reason: string) => {
    addSessionSkippedModel(skippedModel, reason);
    const msg = nextModel
      ? `Skipping ${skippedModel} (${reason}), trying ${nextModel}...`
      : `Skipping ${skippedModel} (${reason}), no more models to try`;
    onProgress({ statusMessage: msg });
  };

  const onModelStart = (model: string) => {
    onProgress({ activeModel: model });
  };

  const onStreamProgress = (phase: 'uploading' | 'processing' | 'streaming', charsReceived: number) => {
    onProgress({ streamPhase: phase, streamChars: charsReceived });
  };

  const onError = (model: string, reason: string, action: string) => {
    onProgress({ errorDetail: `${model}: ${reason} (${action})` });
  };

  onProgress({ status: 'converting', phase: 'scanning', statusMessage: 'Reading PDF...', startedAt: Date.now() });

  const arrayBuffer = await file.arrayBuffer();
  const totalPages = await getPdfPageCount(arrayBuffer);

  // Detect provider capabilities for the transcription model
  const scanProv = getScanProvider();
  const transcribeProv = getTranscribeProvider();
  const scanModels = getScanModelPriority();
  const transcribeModels = getTranscribeModelPriority();
  const transcribePrimary = transcribeModels[0] ?? '';
  const isOcrMode = !(transcribeProv.isPromptCapable?.(transcribePrimary) ?? true);
  const effectiveBatchSize = transcribeProv.prefersFullDocument?.(transcribePrimary) ? totalPages : BATCH_SIZE;
  const totalBatches = Math.ceil(totalPages / effectiveBatchSize);

  onProgress({ totalPages, totalBatches });

  // Pass 1: Extract document outline using the scan provider
  let outline: string;
  if (resumeFrom?.outline) {
    outline = resumeFrom.outline;
    onProgress({ statusMessage: 'Resuming from saved progress...' });
  } else {
    onProgress({ statusMessage: 'Scanning document structure...' });
    const fullPdfBlob = new Blob([arrayBuffer], { type: 'application/pdf' });
    const result = await extractDocumentOutline(
      fullPdfBlob,
      (attempt, delay, reason) => {
        const msg = reason === 'rate_limited'
          ? `Rate limited \u2014 retrying in ${delay}s...`
          : `Structure scan: retrying in ${delay}s (attempt ${attempt})...`;
        onProgress({ statusMessage: msg });
      },
      abortSignal,
      skipModels,
      onModelSkip,
      onModelStart,
      onStreamProgress,
      onError,
      scanProv,
      scanModels,
    );
    outline = result.text;
    onProgress({ streamPhase: undefined, streamChars: 0, statusMessage: `Structure scan complete (${result.modelUsed})` });
    console.log(`[convert] Document outline extracted (${outline.length} chars)`);
  }

  // Pass 2: Convert in batches
  onProgress({ phase: 'converting', progress: 0 });
  const results: string[] = resumeFrom?.results ? [...resumeFrom.results] : [];
  const startBatch = resumeFrom?.completedBatches ?? 0;
  const fullPdfBlob = new Blob([arrayBuffer], { type: 'application/pdf' });

  // A1 — feed the trailing headings from the prior batch into the next batch's
  // prompt so section titles at chunk boundaries aren't re-emitted. Seed from
  // the last completed batch on resume so the first resumed prompt also benefits.
  let previousBatchHeadings = results.length > 0
    ? extractTrailingHeadings(results[results.length - 1], 5)
    : '';

  for (let start = startBatch * effectiveBatchSize; start < totalPages; start += effectiveBatchSize) {
    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    const end = Math.min(start + effectiveBatchSize, totalPages);
    const batchNum = Math.floor(start / effectiveBatchSize) + 1;

    onProgress({
      currentBatch: batchNum,
      statusMessage: `Converting batch ${batchNum}/${totalBatches} (PDF pages ${start + 1}\u2013${end})...`,
    });

    let batchBlob: Blob;
    if (totalPages <= effectiveBatchSize) {
      batchBlob = fullPdfBlob;
    } else {
      const batchBytes = await extractPdfPageRange(arrayBuffer, start, end);
      batchBlob = new Blob([batchBytes], { type: 'application/pdf' });
    }

    const result = await convertPdfBatchToMarkdown(
      batchBlob,
      batchNum,
      totalBatches,
      outline,
      previousBatchHeadings,
      (attempt, delay, reason) => {
        const msg = reason === 'rate_limited'
          ? `Batch ${batchNum}/${totalBatches}: rate limited \u2014 retrying in ${delay}s...`
          : `Batch ${batchNum}/${totalBatches}: retrying in ${delay}s (attempt ${attempt})...`;
        onProgress({ statusMessage: msg });
      },
      abortSignal,
      skipModels,
      onModelSkip,
      onModelStart,
      onStreamProgress,
      onError,
      transcribeProv,
      transcribeModels,
    );
    onProgress({ streamPhase: undefined, streamChars: 0 });
    const cleanedBatch = stripCodeFences(result.text);
    results.push(cleanedBatch);
    previousBatchHeadings = extractTrailingHeadings(cleanedBatch, 5);

    // Persist partial progress after each batch. Awaited so the file flush
    // lands before we begin the next batch — this is what guarantees the
    // Retry button can resume even when a later batch crashes the app.
    await onBatchComplete({
      jobId,
      fileName: file.name,
      sourcePath,
      outline,
      totalPages,
      totalBatches,
      completedBatches: batchNum,
      results,
    });

    // Update bar + text together so they stay in sync
    const nextStart = start + effectiveBatchSize;
    const nextEnd = Math.min(nextStart + effectiveBatchSize, totalPages);
    const nextBatch = batchNum + 1;
    onProgress({
      progress: Math.round((batchNum / totalBatches) * 100),
      statusMessage: nextStart < totalPages
        ? `Converting batch ${nextBatch}/${totalBatches} (PDF pages ${nextStart + 1}\u2013${nextEnd})...`
        : `Finishing up...`,
    });

    if (end < totalPages) {
      await batchDelay(transcribeProv);
    }
  }

  // Default endnote position written to frontmatter (set in the endnote branch).
  let endnotePosition: string | undefined;

  // Always strip fabricated placeholder footnote definitions. These are pure
  // junk ("[^5]: [footnote text not available]") and removing them is safe in
  // every mode — it also rescues an endnote book that the prescan mis-classified.
  {
    const { results: cleaned, removed } = stripPlaceholderFootnoteDefs(results);
    if (removed > 0) {
      results.length = 0;
      results.push(...cleaned);
      onProgress({ statusMessage: `Removed ${removed} empty placeholder footnote(s)` });
      console.log(`[convert] Removed ${removed} placeholder footnote definition(s)`);
    }
  }

  if (parseNoteStyle(outline) === 'endnotes') {
    // Endnote documents: keep the [^N] references and [^N]: definitions exactly as
    // transcribed, with their printed numbers (which may restart each chapter).
    // We deliberately do NOT run the footnote dedupe here — for endnotes the
    // repeated [^1] labels across chapters are meaningful, and the DOCX exporter
    // reconciles reference↔definition (chapter-scoped) when it builds native Word
    // endnotes. The frontmatter `notes: endnotes` flag tells the exporter to do so.
    // (placeholder strip above already removed any fabricated definitions.)
    //
    // Detect whether the printed numbers restart per chapter (a definition number
    // lower than the previous one) to pick the default endnote position written to
    // the frontmatter: per-chapter → end of each section; continuous → end of doc.
    const defNums = [...results.join('\n').matchAll(/^\[\^(\d+)\]:/gm)].map(m => parseInt(m[1], 10));
    let perChapter = false;
    for (let k = 1; k < defNums.length; k++) {
      if (defNums[k] < defNums[k - 1]) { perChapter = true; break; }
    }
    endnotePosition = perChapter ? 'section-end' : 'document-end';
    onProgress({ statusMessage: `Endnotes: ${defNums.length} note(s), ${perChapter ? 'per-chapter' : 'continuous'} numbering` });
    console.log(`[convert] Endnotes: ${defNums.length} [^N]: definition(s), ${perChapter ? 'per-chapter (section-end)' : 'continuous (document-end)'}; exporter builds native Word endnotes`);
  } else {
    // C — guard against duplicate footnote labels across batches. The transcribe
    // prompt preserves each note's printed number as its [^N] label; if the
    // document restarts footnote numbering partway through, two batches can each
    // define [^1], which is invalid Markdown (and silently drops a note). Rename
    // later collisions to a unique \w-safe label. No-op when labels are already
    // unique (the common case, including gapped-but-unique numbering).
    const { results: dedupedFn, renamed: fnRenamed } = dedupeFootnoteLabels(results);
    if (fnRenamed > 0) {
      results.length = 0;
      results.push(...dedupedFn);
      onProgress({ statusMessage: `Footnote labels: ${fnRenamed} duplicate(s) disambiguated` });
      console.log(`[convert] Footnote dedupe: ${fnRenamed} duplicate label(s) renamed across batches`);
    }
  }

  // Report page number extraction for OCR mode
  if (isOcrMode) {
    const joined = results.join('\n\n');
    const pageMarkers = (joined.match(/<!-- page: .+? -->/g) || []).length;
    const pageMsg = `Page numbers: ${pageMarkers} of ${totalPages} pages have printed page markers`;
    onProgress({ statusMessage: pageMsg });
    console.log(`[convert] ${pageMsg}`);
  }

  // For OCR output, use LLM to correct heading levels against the prescan outline
  if (isOcrMode && outline) {
    onProgress({ statusMessage: 'Correcting headings via LLM...' });
    const joined = results.join('\n\n');
    const { correctedMarkdown, stats } = await correctOcrHeadingsWithLlm(joined, outline, {
      provider: scanProv,
      models: scanModels,
      abortSignal,
      skipModels,
      onModelSkip,
      onModelStart,
      onStreamProgress,
      onError,
    });
    results.length = 0;
    results.push(correctedMarkdown);
    const remapMsg = `Heading correction: ${stats.kept} kept, ${stats.demoted} demoted, ${stats.merged} merged (${stats.total} OCR headings)`;
    onProgress({ statusMessage: remapMsg, streamPhase: undefined, streamChars: 0 });
    console.log(`[convert] ${remapMsg}`);
  }

  // Assemble final output
  let body = normalizeBlankLines(results.join('\n\n'));
  // Heading-quality post-processing (duplicates, TOC artifacts, markdown glitches).
  if (getSettings().headingCleanupEnabled) {
    body = cleanHeadings(body);
  }
  const frontmatter = buildFrontmatter(file.name, totalPages, parseNoteStyle(outline), endnotePosition);

  // The prescan `outline` is used internally to set heading levels (batch prompt
  // + OCR heading correction). It is intentionally NOT embedded in the output —
  // a navigable outline is provided by the Preview sidebar instead.
  return `${frontmatter}\n\n${body}`;
}
