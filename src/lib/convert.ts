import type { ConversionJob, PartialProgress } from '../types';
import { getPdfPageCount, extractPdfPageRange } from './pdfUtils';
import { getPrimaryModel, addSessionSkippedModel, getSettings } from './settings';
import {
  getBatchSize,
  extractDocumentOutline,
  convertPdfBatchToMarkdown,
  batchDelay,
} from './gemini';

type ProgressCallback = (update: Partial<ConversionJob>) => void;

export interface ConvertFileOptions {
  file: File;
  jobId: string;
  sourcePath: string;
  onProgress: ProgressCallback;
  onBatchComplete: (progress: PartialProgress) => void;
  resumeFrom?: PartialProgress;
  abortSignal?: AbortSignal;
  translationLanguage?: string;
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
  const { file, jobId, sourcePath, onProgress, onBatchComplete, resumeFrom, abortSignal, translationLanguage } = options;
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
  const totalBatches = Math.ceil(totalPages / BATCH_SIZE);

  onProgress({ totalPages, totalBatches });

  // Pass 1: Extract document outline (skip if resuming)
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

  // Pass 2: Convert in batches
  onProgress({ phase: 'converting', progress: 0 });
  const results: string[] = resumeFrom?.results ? [...resumeFrom.results] : [];
  const startBatch = resumeFrom?.completedBatches ?? 0;
  const fullPdfBlob = new Blob([arrayBuffer], { type: 'application/pdf' });

  for (let start = startBatch * BATCH_SIZE; start < totalPages; start += BATCH_SIZE) {
    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    const end = Math.min(start + BATCH_SIZE, totalPages);
    const batchNum = Math.floor(start / BATCH_SIZE) + 1;

    onProgress({
      currentBatch: batchNum,
      statusMessage: `Converting batch ${batchNum}/${totalBatches} (PDF pages ${start + 1}\u2013${end})...`,
    });

    let batchBlob: Blob;
    if (totalPages <= BATCH_SIZE) {
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
      translationLanguage,
    );
    onProgress({ streamPhase: undefined, streamChars: 0 });
    results.push(stripCodeFences(result.text));

    // Persist partial progress after each batch
    onBatchComplete({
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
    const nextStart = start + BATCH_SIZE;
    const nextEnd = Math.min(nextStart + BATCH_SIZE, totalPages);
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

  // Assemble final output
  const body = normalizeBlankLines(results.join('\n\n'));
  const frontmatter = buildFrontmatter(file.name, totalPages);

  // Include outline as a navigable TOC after frontmatter
  const toc = `\n\n<!-- Document Outline -->\n\n${stripCodeFences(outline)}\n\n---\n`;

  return `${frontmatter}${toc}\n${body}`;
}
