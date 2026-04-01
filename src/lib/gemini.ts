import { GoogleGenAI } from '@google/genai';
import { getApiKey } from './apiKey';

export const BATCH_SIZE = 10;
const MAX_RETRIES = 3;
const BATCH_DELAY_MS = 2000;
const MAX_OUTPUT_TOKENS = 65536;
const PDF_MODELS = ['gemini-3-flash-preview', 'gemini-2.5-flash'] as const;

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
2. Preserve paragraph structure with blank lines between paragraphs.
3. Convert tables to Markdown table syntax.
4. Preserve footnotes using [^N] syntax with definitions at section end.
5. Preserve endnotes and bibliographic references EXACTLY as written.
6. Describe figures/images in [brackets], e.g. [Figure 3: Bar chart of enrollment].
7. Fix hyphenation artifacts from PDF line-breaking.
8. Preserve block quotes using > syntax.
9. Preserve numbered and bulleted lists exactly.
10. Do not add commentary — output only document content as Markdown.
11. Never duplicate content — each passage of text should appear exactly once.`;
}

function getGeminiClient(): GoogleGenAI {
  const key = getApiKey();
  if (!key) {
    throw new Error('Gemini API key is required. Configure it in the settings above.');
  }
  return new GoogleGenAI({ apiKey: key });
}

/** Upload a PDF blob to Gemini and get a streamed text response. */
async function callGemini(
  pdfBlob: Blob,
  prompt: string,
  onRetry?: (attempt: number, delaySec: number) => void,
): Promise<string> {
  let lastError: Error | null = null;
  const sizeMB = (pdfBlob.size / 1024 / 1024).toFixed(1);
  console.log(`[gemini] Uploading ${sizeMB} MB PDF via File API`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const model = PDF_MODELS[(attempt - 1) % PDF_MODELS.length];

    try {
      const ai = getGeminiClient();
      console.log(`[gemini] Attempt ${attempt}/${MAX_RETRIES} with ${model}: uploading...`);

      const uploaded = await ai.files.upload({
        file: pdfBlob,
        config: { mimeType: 'application/pdf' },
      });

      console.log(`[gemini] File uploaded (state: ${(uploaded as any).state})`);

      if (uploaded.name) {
        let fileState = (uploaded as any).state;
        while (fileState === 'PROCESSING') {
          console.log(`[gemini] File still processing, waiting 2s...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          const fileInfo = await ai.files.get({ name: uploaded.name });
          fileState = (fileInfo as any).state;
        }
      }

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
        const part = chunk.text || '';
        text += part;
      }
      console.log(`[gemini] Streaming complete, received ${text.length} chars`);

      // Clean up uploaded file (fire-and-forget)
      if (uploaded.name) {
        ai.files.delete({ name: uploaded.name }).catch(() => {});
      }

      return text;
    } catch (error: any) {
      lastError = error;
      console.warn(`[gemini] Attempt ${attempt} failed (${model}):`, error.message);
      if (attempt < MAX_RETRIES) {
        const delaySec = attempt * 5;
        onRetry?.(attempt + 1, delaySec);
        await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
      }
    }
  }

  throw lastError || new Error('Gemini API call failed after retries');
}

/** Pass 1: Extract document outline (TOC + heading hierarchy + page numbering scheme). */
export async function extractDocumentOutline(
  pdfBlob: Blob,
  onRetry?: (attempt: number, delaySec: number) => void,
): Promise<string> {
  return callGemini(pdfBlob, PRESCAN_PROMPT, onRetry);
}

/** Pass 2: Convert a batch of pages to Markdown, with outline context. */
export async function convertPdfBatchToMarkdown(
  pdfBlob: Blob,
  batchNum: number,
  totalBatches: number,
  outline: string,
  onRetry?: (attempt: number, delaySec: number) => void,
): Promise<string> {
  const prompt = buildBatchPrompt(batchNum, totalBatches, outline);
  return callGemini(pdfBlob, prompt, onRetry);
}

/** Pause between batches to respect rate limits. */
export function batchDelay(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
}
