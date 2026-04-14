import type { ConversionJob, PartialProgress } from '../types';
import { getPdfPageCount, extractPdfPageRange } from './pdfUtils';
import { getPrimaryModel, addSessionSkippedModel, getSettings } from './settings';
import {
  getBatchSize,
  extractDocumentOutline,
  convertPdfBatchToMarkdown,
  batchDelay,
  extractTrailingHeadings,
} from './gemini';
import { cleanHeadings, flattenOutlineHeadings } from './headingCleanup';
import { getActiveProvider } from './providers/registry';

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
 * Remap heading levels in OCR markdown to match a prescan outline.
 * Builds a map of normalized heading text → correct level from the outline,
 * then replaces heading prefixes in the markdown.
 */
function remapHeadingsFromOutline(markdown: string, outline: string): string {
  // Build heading text → level map from the prescan outline
  const levelMap = new Map<string, number>();
  for (const line of outline.split('\n')) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) {
      const key = normalizeHeadingText(m[2]);
      if (!levelMap.has(key)) levelMap.set(key, m[1].length);
    }
  }

  if (levelMap.size === 0) return markdown;

  let remapped = 0;
  const result = markdown.split('\n').map(line => {
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

  console.log(`[convert] Remapped ${remapped} heading level(s) from prescan outline`);
  return result;
}

/** Normalize heading text for fuzzy matching (trim, collapse whitespace, lowercase). */
function normalizeHeadingText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Build YAML frontmatter from file metadata. */
function buildFrontmatter(fileName: string, totalPages: number): string {
  const title = fileName
    .replace(/\.pdf$/i, '')
    .replace(/_/g, ' ')
    .replace(/ - /g, ' \u2014 ')
    .replace(/\s+/g, ' ')
    .trim();
  const date = new Date().toISOString().split('T')[0];
  const model = getPrimaryModel();
  const provider = getSettings().activeProvider;
  return `---
title: "${title}"
source_file: "${fileName}"
pages: ${totalPages}
converted: "${date}"
converter: "PDF Transcriber"
provider: "${provider}"
model: "${model}"
---`;
}

/** Convert a single PDF file to Markdown, with optional resume and cancel support. */
export async function convertFile(options: ConvertFileOptions): Promise<string> {
  const { file, jobId, sourcePath, onProgress, onBatchComplete, resumeFrom, abortSignal } = options;
  const BATCH_SIZE = getBatchSize();

  // In-memory set of models to skip — accumulates across batches within this job only.
  // Never persisted; garbage-collected when the job finishes.
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

  // Detect provider capabilities for the primary model
  const provider = getActiveProvider();
  const primaryModel = getPrimaryModel();
  const isOcrMode = !(provider.isPromptCapable?.(primaryModel) ?? true);
  const effectiveBatchSize = provider.prefersFullDocument?.(primaryModel) ? totalPages : BATCH_SIZE;
  const totalBatches = Math.ceil(totalPages / effectiveBatchSize);

  onProgress({ totalPages, totalBatches });

  // For OCR models, temporarily skip them for the prescan so a chat model handles it
  if (isOcrMode) skipModels.add(primaryModel);

  // Pass 1: Extract document outline
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
    );
    outline = result.text;
    onProgress({ streamPhase: undefined, streamChars: 0, statusMessage: `Structure scan complete (${result.modelUsed})` });
    console.log(`[convert] Document outline extracted (${outline.length} chars)`);
  }

  // Re-enable the OCR model for the actual conversion
  if (isOcrMode) skipModels.delete(primaryModel);

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
      await batchDelay();
    }
  }

  // For OCR output, remap heading levels to match the prescan outline
  if (isOcrMode && outline) {
    const joined = results.join('\n\n');
    const remapped = remapHeadingsFromOutline(joined, outline);
    results.length = 0;
    results.push(remapped);
    console.log(`[convert] OCR headings remapped to match prescan outline`);
  }

  // Assemble final output
  let body = normalizeBlankLines(results.join('\n\n'));
  // Heading-quality post-processing (duplicates, TOC artifacts, markdown glitches).
  // Applied to body only — the outline TOC block below is prescan output and
  // must not be deduped against body headings.
  if (getSettings().headingCleanupEnabled) {
    body = cleanHeadings(body);
  }
  const frontmatter = buildFrontmatter(file.name, totalPages);

  // Include outline as a navigable TOC after frontmatter
  const toc = `\n\n<!-- Document Outline -->\n\n${stripCodeFences(outline)}\n\n---\n`;

  let assembled = `${frontmatter}${toc}\n${body}`;
  // Flatten heading-shaped TOC entries inside the outline block to bullets,
  // so the navigable outline doesn't pollute heading counts / outline sidebar.
  // Done last so the body-only cleanup above isn't confused by outline headings.
  if (getSettings().headingCleanupEnabled) {
    assembled = flattenOutlineHeadings(assembled);
  }
  return assembled;
}
