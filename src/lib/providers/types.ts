/** Identifies a supported API provider. */
export type ProviderId = 'gemini' | 'openrouter' | 'anthropic' | 'openai' | 'custom';

/** Options passed to a single API attempt (no retry logic). */
export interface ProviderCallOptions {
  model: string;
  prompt: string;
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
  onStreamProgress?: (phase: 'uploading' | 'processing' | 'streaming', charsReceived: number) => void;
}

/** Result from a single successful call. */
export interface ProviderResult {
  text: string;
  modelUsed: string;
}

/** A model descriptor returned by the provider's model listing. */
export interface ProviderModel {
  id: string;
  displayName: string;
  isFree?: boolean;
  pricePerMTokens?: number;
  contextLength?: number;
}

/**
 * Each provider implements this interface.
 * Retry/fallback orchestration lives outside, in callWithRetry().
 */
export interface Provider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly keyPlaceholder: string;
  readonly keyHelpUrl: string;
  readonly keyHelpSteps: string[];
  readonly defaultModels: string[];
  readonly batchDelayMs: number;

  /** Validate an API key (lightweight check). */
  validateKey(key: string): Promise<{ valid: boolean; error?: string }>;

  /** Fetch available models for the given key. */
  fetchModels(key: string): Promise<ProviderModel[]>;

  /**
   * Execute a single API call: send a PDF blob + prompt, stream back text.
   * Does NOT contain retry logic — the orchestrator handles that.
   */
  call(pdfBlob: Blob, options: ProviderCallOptions): Promise<ProviderResult>;

  /**
   * Text-only call (no PDF). Used for markdown translation.
   * Sends a text prompt and streams back the response.
   */
  callText(options: ProviderCallOptions): Promise<ProviderResult>;

  /** Classify errors thrown by call(). */
  isRateLimitError(error: any): boolean;
  isPersistentError(error: any): boolean;
  /** Transient overload (HTTP 503 / "unavailable"). Service will recover — worth patient retries. */
  isOverloadedError(error: any): boolean;
  summarizeError(error: any): string;
}
