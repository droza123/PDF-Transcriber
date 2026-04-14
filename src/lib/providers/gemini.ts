import { GoogleGenAI } from '@google/genai';
import type { Provider, ProviderCallOptions, ProviderModel, ProviderResult } from './types';

const MAX_OUTPUT_TOKENS = 65536;

export class GeminiProvider implements Provider {
  readonly id = 'gemini' as const;
  readonly displayName = 'Google Gemini';
  readonly keyPlaceholder = 'Paste your Gemini API key';
  readonly keyHelpUrl = 'https://aistudio.google.com/apikey';
  readonly keyHelpSteps = [
    'Go to Google AI Studio',
    'Sign in with your Google account',
    'Click "Create API Key"',
    'Copy the key and paste it above',
  ];
  readonly defaultModels = [
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash-lite-preview',
    'gemini-3-flash',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
  ];
  readonly batchDelayMs = 2000;

  async validateKey(key: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      await ai.models.get({ model: 'gemini-2.5-flash' });
      return { valid: true };
    } catch (e: any) {
      return { valid: false, error: e.message || 'Invalid API key' };
    }
  }

  async fetchModels(key: string): Promise<ProviderModel[]> {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      );
      if (!res.ok) return [];
      const data = await res.json();
      const models: ProviderModel[] = (data.models || [])
        .filter((m: any) =>
          m.supportedGenerationMethods?.includes('generateContent') &&
          /flash|pro/i.test(m.name) &&
          /gemini-(2|3|4)/i.test(m.name) &&
          !/thinking|embedding|aqa|text|tts/i.test(m.name),
        )
        .map((m: any) => ({
          id: m.name.replace('models/', ''),
          displayName: m.displayName || m.name.replace('models/', ''),
          isFree: true, // Gemini free tier
        }))
        .sort((a: ProviderModel, b: ProviderModel) => b.id.localeCompare(a.id));
      return models;
    } catch {
      return [];
    }
  }

  async call(pdfBlob: Blob, options: ProviderCallOptions): Promise<ProviderResult> {
    const { model, prompt, abortSignal, onStreamProgress } = options;
    const key = this._getKey();
    const ai = new GoogleGenAI({ apiKey: key });

    const sizeMB = (pdfBlob.size / 1024 / 1024).toFixed(1);
    console.log(`[gemini] Uploading ${sizeMB} MB PDF via File API`);
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
  }

  async callText(options: ProviderCallOptions): Promise<ProviderResult> {
    const { model, prompt, abortSignal, onStreamProgress } = options;
    const key = this._getKey();
    const ai = new GoogleGenAI({ apiKey: key });

    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    onStreamProgress?.('streaming', 0);

    const stream = await ai.models.generateContentStream({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { maxOutputTokens: 65536 },
    });

    let text = '';
    for await (const chunk of stream) {
      if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      text += chunk.text || '';
      onStreamProgress?.('streaming', text.length);
    }

    return { text, modelUsed: model };
  }

  isRateLimitError(error: any): boolean {
    return (
      error?.status === 429 ||
      error?.code === 'RESOURCE_EXHAUSTED' ||
      /429|rate.?limit|resource.?exhausted/i.test(error?.message || '')
    );
  }

  isPersistentError(error: any): boolean {
    const status = error?.status;
    if (status === 401 || status === 403 || status === 404 || status === 400) return true;
    if (/not.?found|invalid.?model|permission.?denied|unauthorized|bad.?request/i.test(error?.message || '')) return true;
    return false;
  }

  isOverloadedError(error: any): boolean {
    return (
      error?.status === 503 ||
      /503|overloaded|service.?unavailable|temporarily.?unavailable/i.test(error?.message || '')
    );
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

  private _getKey(): string {
    // Import dynamically to avoid circular deps — key storage is in apiKey.ts
    const key = localStorage.getItem('provider_api_key_gemini')
      || localStorage.getItem('gemini_api_key')  // migration fallback
      || null;
    if (!key) throw new Error('Gemini API key is required. Configure it in the settings above.');
    return key;
  }
}
