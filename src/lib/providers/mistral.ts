import type { Provider, ProviderCallOptions, ProviderModel, ProviderResult } from './types';
import { pdfToImages } from '../pdfImages';

const API_BASE = 'https://api.mistral.ai/v1';

export class MistralProvider implements Provider {
  readonly id = 'mistral' as const;
  readonly displayName = 'Mistral';
  readonly keyPlaceholder = 'Paste your Mistral API key';
  readonly keyHelpUrl = 'https://console.mistral.ai/api-keys';
  readonly keyHelpSteps = [
    'Mistral Console',
    'Sign in or create an account',
    'Go to API Keys',
    'Create a new key and paste it above',
  ];
  readonly defaultModels = [
    'mistral-ocr-latest',
    'mistral-small-latest',
  ];
  readonly batchDelayMs = 5000;

  async validateKey(key: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/models`, {
        headers: { 'Authorization': `Bearer ${key}` },
      });
      if (res.ok) return { valid: true };
      const data = await res.json().catch(() => ({}));
      return { valid: false, error: data?.message || `HTTP ${res.status}` };
    } catch (e: any) {
      return { valid: false, error: e.message || 'Connection failed' };
    }
  }

  async fetchModels(key: string): Promise<ProviderModel[]> {
    try {
      const res = await fetch(`${API_BASE}/models`, {
        headers: { 'Authorization': `Bearer ${key}` },
      });
      if (!res.ok) return [];
      const data = await res.json();
      const rawModels: { id: string; name?: string; capabilities?: any }[] = data.data || [];

      // Include OCR models and chat models suitable for vision/text tasks.
      // Filter out embedding, moderation, and code-only models.
      const relevant = rawModels.filter(m =>
        /ocr|small|medium|large|pixtral/i.test(m.id) &&
        !/embed|moder/i.test(m.id),
      );

      return relevant.map(m => ({
        id: m.id,
        displayName: m.name || m.id,
      }));
    } catch {
      return [];
    }
  }

  async call(pdfBlob: Blob, options: ProviderCallOptions): Promise<ProviderResult> {
    if (this._isOcrModel(options.model)) {
      return this._callOcr(pdfBlob, options);
    }
    return this._callVision(pdfBlob, options);
  }

  async callText(options: ProviderCallOptions): Promise<ProviderResult> {
    const { model } = options;

    // OCR models can't do text-to-text; throw persistent error so orchestrator
    // falls through to the next model (e.g. mistral-small-latest).
    if (this._isOcrModel(model)) {
      const error: any = new Error(
        `${model} is an OCR model and cannot be used for text tasks. ` +
        'Add a Mistral chat model (e.g. mistral-small-latest) to your model priority list.',
      );
      error.status = 400;
      throw error;
    }

    return this._callChat(options);
  }

  // ── Error classification ──

  isRateLimitError(error: any): boolean {
    return (
      error?.status === 429 ||
      /429|rate.?limit/i.test(error?.message || '')
    );
  }

  isPersistentError(error: any): boolean {
    const status = error?.status;
    if (status === 401 || status === 403 || status === 404 || status === 400) return true;
    if (/not.?found|invalid.?model|permission.?denied|unauthorized|bad.?request/i.test(error?.message || '')) return true;
    return false;
  }

  isOverloadedError(error: any): boolean {
    return error?.status === 503 || /503|overloaded|service.?unavailable/i.test(error?.message || '');
  }

  summarizeError(error: any): string {
    if (this.isRateLimitError(error)) return 'rate limited';
    if (this.isOverloadedError(error)) return 'service overloaded (503)';
    const status = error?.status;
    if (status === 401 || status === 403) return 'auth error';
    if (status === 404) return 'model not found';
    if (status === 400) return 'bad request';
    if (status >= 500) return `server error (${status})`;
    return error?.message?.slice(0, 60) || 'unknown error';
  }

  // ── Capability hints ──

  isPromptCapable(model: string): boolean {
    return !this._isOcrModel(model);
  }

  prefersFullDocument(model: string): boolean {
    return this._isOcrModel(model);
  }

  // ── Private helpers ──

  private _isOcrModel(model: string): boolean {
    return /^mistral-ocr/i.test(model);
  }

  /**
   * Extract a printed page number from OCR header/footer text.
   * Looks for an isolated arabic number or roman numeral.
   */
  static _extractPageNumber(header?: string | null, footer?: string | null): string | null {
    // Check footer first (most common location for page numbers), then header
    for (const text of [footer, header]) {
      if (!text) continue;
      const trimmed = text.trim();
      // Match an isolated number (arabic) or roman numeral
      // Page numbers are usually standalone or surrounded by whitespace/punctuation
      const m = trimmed.match(/(?:^|\s)(\d{1,4})(?:\s|$)/) ||
                trimmed.match(/(?:^|\s)([ivxlcdm]{1,8})(?:\s|$)/i);
      if (m) {
        const candidate = m[1].trim();
        // Validate roman numerals (must be a valid sequence, not random letters)
        if (/^[ivxlcdm]+$/i.test(candidate)) {
          if (/^[ivxlcdm]+$/i.test(candidate) && MistralProvider._isValidRoman(candidate)) {
            return candidate.toLowerCase();
          }
        } else {
          return candidate;
        }
      }
    }
    return null;
  }

  /** Check if a string is a valid roman numeral (not just random letters). */
  static _isValidRoman(s: string): boolean {
    return /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i.test(s) && s.length > 0;
  }

  private _getKey(): string {
    const key = localStorage.getItem('provider_api_key_mistral') || null;
    if (!key) throw new Error('Mistral API key is required. Configure it in the settings above.');
    return key;
  }

  /** OCR path: POST /v1/ocr — sends PDF, receives structured markdown (no streaming). */
  private async _callOcr(pdfBlob: Blob, options: ProviderCallOptions): Promise<ProviderResult> {
    const { model, abortSignal, onStreamProgress } = options;
    const key = this._getKey();

    onStreamProgress?.('uploading', 0);

    const arrayBuffer = await pdfBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    const sizeMB = (pdfBlob.size / 1024 / 1024).toFixed(1);
    console.log(`[mistral] Sending ${sizeMB} MB PDF to OCR endpoint with ${model}`);
    onStreamProgress?.('processing', 0);

    const res = await fetch(`${API_BASE}/ocr`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        document: {
          type: 'document_url',
          document_url: `data:application/pdf;base64,${base64}`,
        },
        include_image_base64: true,
        table_format: 'markdown',
        extract_header: true,
        extract_footer: true,
      }),
      signal: abortSignal,
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const error: any = new Error(errorData?.message || errorData?.error?.message || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }

    const data = await res.json();
    const pages: {
      index: number;
      markdown: string;
      header?: string | null;
      footer?: string | null;
      images?: { id: string; image_base64?: string }[];
    }[] = data.pages || [];

    let imageCount = 0;
    let pageNumberCount = 0;
    const text = pages
      .map(p => {
        let md = p.markdown;

        // Strip header/footer text from the body markdown (extract_header/footer: true
        // includes them in both the markdown AND the separate fields — we want them only
        // in the fields so we can read page numbers without polluting the body)
        if (p.header) {
          for (const hl of p.header.trim().split('\n').map(l => l.trim()).filter(Boolean)) {
            md = md.replace(new RegExp('^' + hl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\n?', 'm'), '');
          }
        }
        if (p.footer) {
          for (const fl of p.footer.trim().split('\n').map(l => l.trim()).filter(Boolean)) {
            md = md.replace(new RegExp('^' + fl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\n?', 'm'), '');
          }
        }

        // Replace image placeholder URLs with inline base64 data URIs
        if (p.images?.length) {
          for (const img of p.images) {
            if (!img.id || !img.image_base64) continue;
            const dataUri = img.image_base64.startsWith('data:')
              ? img.image_base64
              : `data:image/jpeg;base64,${img.image_base64}`;
            md = md.replaceAll(`](${img.id})`, `](${dataUri})`);
            imageCount++;
          }
        }

        // Extract ALL printed page numbers from header and footer (two-page spreads have two)
        const pageNums: string[] = [];
        const isValidRoman = (s: string) =>
          /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i.test(s) && s.length > 0;
        const romanToNum = (s: string) => {
          const v: Record<string, number> = { i:1, v:5, x:10, l:50, c:100, d:500, m:1000 };
          let n = 0; const lc = s.toLowerCase();
          for (let j = 0; j < lc.length; j++) { const cur = v[lc[j]]||0, next = v[lc[j+1]]||0; n += cur < next ? -cur : cur; }
          return n;
        };

        for (const hfText of [p.header, p.footer]) {
          if (!hfText) continue;
          // Find all isolated numbers (arabic or roman) in the header/footer text
          const arabicMatches = [...hfText.matchAll(/(?:^|\s)(\d{1,4})(?:\s|$)/gm)];
          for (const m of arabicMatches) {
            const num = m[1].trim();
            if (num && !pageNums.includes(num)) pageNums.push(num);
          }
          const romanMatches = [...hfText.matchAll(/(?:^|\s)([ivxlcdm]{1,8})(?:\s|$)/gi)];
          for (const m of romanMatches) {
            const candidate = m[1].trim().toLowerCase();
            if (candidate && isValidRoman(candidate) && !pageNums.includes(candidate)) {
              pageNums.push(candidate);
            }
          }
        }

        if (pageNums.length > 0) {
          pageNumberCount++;
          // Sort numerically (arabic or roman) and format as single or range
          const isRoman = /^[ivxlcdm]+$/i.test(pageNums[0]);
          if (isRoman) {
            pageNums.sort((a, b) => romanToNum(a) - romanToNum(b));
          } else {
            pageNums.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
          }
          const pageLabel = pageNums.length === 1
            ? pageNums[0]
            : `${pageNums[0]}-${pageNums[pageNums.length - 1]}`;
          return `<!-- page: ${pageLabel} -->\n${md}`;
        }
        return md;
      })
      .join('\n\n');

    console.log(`[mistral] OCR complete: ${pages.length} pages, ${imageCount} images, ${pageNumberCount} page numbers`);
    onStreamProgress?.('streaming', text.length);
    onStreamProgress?.('streaming', text.length);

    return { text, modelUsed: model };
  }

  /** Vision path: POST /v1/chat/completions with page images (SSE streaming). */
  private async _callVision(pdfBlob: Blob, options: ProviderCallOptions): Promise<ProviderResult> {
    const { model, prompt, maxOutputTokens, abortSignal, onStreamProgress } = options;
    const key = this._getKey();

    onStreamProgress?.('uploading', 0);

    const imageDataUrls = await pdfToImages(pdfBlob);

    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    console.log(`[mistral] Sending ${imageDataUrls.length} page image(s) to ${model}`);
    onStreamProgress?.('streaming', 0);

    const content: any[] = [
      ...imageDataUrls.map(url => ({
        type: 'image_url',
        image_url: { url },
      })),
      { type: 'text', text: prompt },
    ];

    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        stream: true,
        messages: [{ role: 'user', content }],
      }),
      signal: abortSignal,
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const error: any = new Error(errorData?.message || errorData?.error?.message || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }

    return this._readStream(res, abortSignal, onStreamProgress, model);
  }

  /** Text-only chat completions (for translation). */
  private async _callChat(options: ProviderCallOptions): Promise<ProviderResult> {
    const { model, prompt, maxOutputTokens, abortSignal, onStreamProgress } = options;
    const key = this._getKey();

    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    onStreamProgress?.('streaming', 0);

    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: abortSignal,
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const error: any = new Error(errorData?.message || errorData?.error?.message || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }

    return this._readStream(res, abortSignal, onStreamProgress, model);
  }

  /** Parse an SSE stream from Mistral's OpenAI-compatible chat/completions. */
  private async _readStream(
    res: Response,
    abortSignal: AbortSignal | undefined,
    onStreamProgress: ProviderCallOptions['onStreamProgress'],
    model: string,
  ): Promise<ProviderResult> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let buffer = '';

    while (true) {
      if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          if (event.error) {
            const error: any = new Error(event.error.message || 'Stream error');
            error.status = event.error.code || 500;
            throw error;
          }
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            onStreamProgress?.('streaming', text.length);
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }

    console.log(`[mistral] Streaming complete, received ${text.length} chars`);
    return { text, modelUsed: model };
  }
}
