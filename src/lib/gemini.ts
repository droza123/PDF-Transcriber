import { GoogleGenAI } from '@google/genai';
import { getApiKey } from './apiKey';
import { getSettings, DEFAULT_MODELS } from './settings';

const BATCH_DELAY_MS = 2000;
const MAX_OUTPUT_TOKENS = 65536;

/** Dynamic batch size from settings. */
export function getBatchSize(): number {
  return getSettings().batchSize;
}

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
  const extra = settings.outputNotes ? `\n\nAdditional instructions:\n${settings.outputNotes}` : '';

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

function getGeminiClient(): GoogleGenAI {
  const key = getApiKey();
  if (!key) {
    throw new Error('Gemini API key is required. Configure it in the settings above.');
  }
  return new GoogleGenAI({ apiKey: key });
}

/** Get the ordered list of models to try from user settings. */
function getModelPriority(): string[] {
  const { modelPriority } = getSettings();
  if (modelPriority.length > 0) return modelPriority;
  return DEFAULT_MODELS;
}

/** Check if an error is a rate limit (429). */
function isRateLimitError(error: any): boolean {
  return (
    error?.status === 429 ||
    error?.code === 'RESOURCE_EXHAUSTED' ||
    /429|rate.?limit|resource.?exhausted/i.test(error?.message || '')
  );
}

/** Check if an error is persistent (model won't recover). */
function isPersistentError(error: any): boolean {
  const status = error?.status;
  if (status === 401 || status === 403 || status === 404 || status === 400) return true;
  if (/not.?found|invalid.?model|permission.?denied|unauthorized|bad.?request/i.test(error?.message || '')) return true;
  return false;
}

/** Summarize an error for display. */
function summarizeError(error: any): string {
  if (isRateLimitError(error)) return 'rate limited';
  const status = error?.status;
  if (status === 401 || status === 403) return 'auth error';
  if (status === 404) return 'model not found';
  if (status === 400) return 'bad request';
  if (status >= 500) return `server error (${status})`;
  return error?.message?.slice(0, 60) || 'unknown error';
}

export interface GeminiCallOptions {
  onRetry?: (attempt: number, delaySec: number, reason?: string) => void;
  onModelSkip?: (skippedModel: string, nextModel: string | null, reason: string) => void;
  onModelStart?: (model: string) => void;
  onStreamProgress?: (phase: 'uploading' | 'processing' | 'streaming', charsReceived: number) => void;
  onError?: (model: string, reason: string, action: string) => void;
  abortSignal?: AbortSignal;
  skipModels?: Set<string>;
}

export interface GeminiResult {
  text: string;
  modelUsed: string;
}

/** Upload a PDF blob to Gemini and get a streamed text response. */
async function callGemini(
  pdfBlob: Blob,
  prompt: string,
  options: GeminiCallOptions = {},
): Promise<GeminiResult> {
  const { onRetry, onModelSkip, onModelStart, onStreamProgress, onError, abortSignal, skipModels } = options;

  const allModels = getModelPriority();
  const models = allModels.filter(m => !skipModels?.has(m));

  if (models.length === 0) {
    const skippedList = allModels.map(m => `${m} (previously failed)`).join(', ');
    throw new Error(`All models failed. Every model in your priority list was skipped due to prior errors: ${skippedList}`);
  }

  // 2 attempts per model before moving to the next one
  const TRIES_PER_MODEL = 2;
  const maxAttempts = models.length * TRIES_PER_MODEL;
  const failureLog: { model: string; reason: string }[] = [];
  const rateLimitHits = new Set<string>(); // models rate-limited at least once in this call
  let lastError: Error | null = null;
  const sizeMB = (pdfBlob.size / 1024 / 1024).toFixed(1);
  console.log(`[gemini] Uploading ${sizeMB} MB PDF via File API`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const model = models[Math.floor((attempt - 1) / TRIES_PER_MODEL) % models.length];
    onModelStart?.(model);

    try {
      if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

      const ai = getGeminiClient();
      console.log(`[gemini] Attempt ${attempt}/${maxAttempts} with ${model}: uploading...`);
      onStreamProgress?.('uploading', 0);

      const uploaded = await ai.files.upload({
        file: pdfBlob,
        config: { mimeType: 'application/pdf' },
      });

      if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

      console.log(`[gemini] File uploaded (state: ${(uploaded as any).state})`);

      if (uploaded.name) {
        let fileState = (uploaded as any).state;
        while (fileState === 'PROCESSING') {
          onStreamProgress?.('processing', 0);
          if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
          console.log(`[gemini] File still processing, waiting 2s...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          const fileInfo = await ai.files.get({ name: uploaded.name });
          fileState = (fileInfo as any).state;
        }
      }

      if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

      console.log(`[gemini] Streaming content with ${model}...`);

      const stream = await ai.models.generateContentStream({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { fileUri: uploaded.uri!, mimeType: uploaded.mimeType! } },
              { text: prompt },
            ],
          },
        ],
        config: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      });

      let text = '';
      for await (const chunk of stream) {
        if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        const part = chunk.text || '';
        text += part;
        onStreamProgress?.('streaming', text.length);
      }
      console.log(`[gemini] Streaming complete, received ${text.length} chars`);

      // Clean up uploaded file (fire-and-forget)
      if (uploaded.name) {
        ai.files.delete({ name: uploaded.name }).catch(() => {});
      }

      return { text, modelUsed: model };
    } catch (error: any) {
      // Don't retry if cancelled
      if (error.name === 'AbortError') throw error;

      lastError = error;
      const reason = summarizeError(error);
      failureLog.push({ model, reason });
      console.warn(`[gemini] Attempt ${attempt} failed (${model}): ${reason}`);

      // Decide whether to skip this model for the rest of the job.
      // Skip on persistent errors immediately, or on repeated rate limits
      // (e.g. daily quota exhaustion on the free tier).
      const isRateLimit = isRateLimitError(error);
      const repeatedRateLimit = isRateLimit && rateLimitHits.has(model);
      if (isRateLimit) rateLimitHits.add(model);
      const shouldSkip = isPersistentError(error) || repeatedRateLimit;

      const nextModelInRotation = attempt < maxAttempts ? models[Math.floor(attempt / TRIES_PER_MODEL) % models.length] : null;
      if (shouldSkip && skipModels) {
        skipModels.add(model);
        const nextAvailable = models.find(m => m !== model && !skipModels.has(m)) ?? null;
        onError?.(model, reason, nextAvailable ? `skipping model, trying ${nextAvailable}` : 'skipping model, no models left');
        onModelSkip?.(model, nextAvailable, reason);
        console.log(`[gemini] Model ${model} added to skip list (${reason})`);
      } else if (attempt < maxAttempts) {
        onError?.(model, reason, `retrying with ${nextModelInRotation}`);
      } else {
        onError?.(model, reason, 'no retries left');
      }

      if (attempt < maxAttempts) {
        // Short delay when skipping to next model; moderate for a first rate-limit retry
        const delaySec = shouldSkip ? 2 : isRateLimit ? 10 : attempt * 5;
        onRetry?.(attempt + 1, delaySec, isRateLimit ? 'rate_limited' : undefined);
        console.log(`[gemini] Retrying with ${nextModelInRotation} in ${delaySec}s...`);
        await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
      }
    }
  }

  // All attempts exhausted — build a descriptive error message
  const details = failureLog.map(f => `${f.model} (${f.reason})`).join(', ');
  throw new Error(`All models failed. Tried: ${details}`);
}

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
): Promise<GeminiResult> {
  return callGemini(pdfBlob, PRESCAN_PROMPT, { onRetry, abortSignal, skipModels, onModelSkip, onModelStart, onStreamProgress, onError });
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
): Promise<GeminiResult> {
  const prompt = buildBatchPrompt(batchNum, totalBatches, outline);
  return callGemini(pdfBlob, prompt, { onRetry, abortSignal, skipModels, onModelSkip, onModelStart, onStreamProgress, onError });
}

/** Pause between batches to respect rate limits. */
export function batchDelay(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
}
