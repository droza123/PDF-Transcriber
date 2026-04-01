import type { ConversionJob } from '../types';
import { getPdfPageCount, extractPdfPageRange } from './pdfUtils';
import {
  BATCH_SIZE,
  extractDocumentOutline,
  convertPdfBatchToMarkdown,
  batchDelay,
} from './gemini';

type ProgressCallback = (update: Partial<ConversionJob>) => void;

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
    .replace(/ - /g, ' — ')
    .replace(/\s+/g, ' ')
    .trim();
  const date = new Date().toISOString().split('T')[0];
  return `---
title: "${title}"
source_file: "${fileName}"
pages: ${totalPages}
converted: "${date}"
converter: "PDFtoMarkdownBatch (Gemini Flash)"
---`;
}

/** Convert a single PDF file to Markdown. */
export async function convertFile(
  file: File,
  onProgress: ProgressCallback,
): Promise<string> {
  onProgress({ status: 'converting', phase: 'scanning', statusMessage: 'Reading PDF...', startedAt: Date.now() });

  const arrayBuffer = await file.arrayBuffer();
  const totalPages = await getPdfPageCount(arrayBuffer);
  const totalBatches = Math.ceil(totalPages / BATCH_SIZE);

  onProgress({ totalPages, totalBatches });

  // Pass 1: Extract document outline
  onProgress({ statusMessage: 'Scanning document structure...' });
  const fullPdfBlob = new Blob([arrayBuffer], { type: 'application/pdf' });
  const outline = await extractDocumentOutline(fullPdfBlob, (attempt, delay) => {
    onProgress({ statusMessage: `Structure scan: retrying in ${delay}s (attempt ${attempt})...` });
  });
  console.log(`[convert] Document outline extracted (${outline.length} chars)`);

  // Pass 2: Convert in batches
  onProgress({ phase: 'converting', progress: 0 });
  const results: string[] = [];

  for (let start = 0; start < totalPages; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, totalPages);
    const batchNum = Math.floor(start / BATCH_SIZE) + 1;

    onProgress({
      currentBatch: batchNum,
      statusMessage: `Converting batch ${batchNum}/${totalBatches} (PDF pages ${start + 1}–${end})...`,
      progress: Math.round(((batchNum - 1) / totalBatches) * 100),
    });

    let batchBlob: Blob;
    if (totalPages <= BATCH_SIZE) {
      // Small PDF — use as-is
      batchBlob = fullPdfBlob;
    } else {
      const batchBytes = await extractPdfPageRange(arrayBuffer, start, end);
      batchBlob = new Blob([batchBytes], { type: 'application/pdf' });
    }

    const markdown = await convertPdfBatchToMarkdown(
      batchBlob,
      batchNum,
      totalBatches,
      outline,
      (attempt, delay) => {
        onProgress({
          statusMessage: `Batch ${batchNum}/${totalBatches}: retrying in ${delay}s (attempt ${attempt})...`,
        });
      },
    );

    results.push(stripCodeFences(markdown));

    onProgress({ progress: Math.round((batchNum / totalBatches) * 100) });

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
