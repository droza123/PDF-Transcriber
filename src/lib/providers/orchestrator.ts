import type { Provider, ProviderResult } from './types';
import { getActiveProvider } from './registry';
import { getActiveModelPriority } from '../settings';

export interface OrchestratorCallOptions {
  onRetry?: (attempt: number, delaySec: number, reason?: string) => void;
  onModelSkip?: (skippedModel: string, nextModel: string | null, reason: string) => void;
  onModelStart?: (model: string) => void;
  onStreamProgress?: (phase: 'uploading' | 'processing' | 'streaming', charsReceived: number) => void;
  onError?: (model: string, reason: string, action: string) => void;
  abortSignal?: AbortSignal;
  skipModels?: Set<string>;
}

export type { ProviderResult as OrchestratorResult };

const MAX_OUTPUT_TOKENS = 65536;

/**
 * Call the active provider with retry/fallback across models.
 * Provider-agnostic extraction of the old callGemini() retry loop.
 */
export async function callWithRetry(
  pdfBlob: Blob,
  prompt: string,
  options: OrchestratorCallOptions = {},
): Promise<ProviderResult> {
  const { onRetry, onModelSkip, onModelStart, onStreamProgress, onError, abortSignal, skipModels } = options;
  const provider: Provider = getActiveProvider();

  const allModels = getActiveModelPriority();
  const models = allModels.filter(m => !skipModels?.has(m));

  if (models.length === 0) {
    const skippedList = allModels.map(m => `${m} (previously failed)`).join(', ');
    throw new Error(`All models failed. Every model in your priority list was skipped due to prior errors: ${skippedList}`);
  }

  const TRIES_PER_MODEL = 2;
  const maxAttempts = models.length * TRIES_PER_MODEL;
  const failureLog: { model: string; reason: string; overloaded: boolean }[] = [];
  const rateLimitHits = new Set<string>();
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const model = models[Math.floor((attempt - 1) / TRIES_PER_MODEL) % models.length];
    onModelStart?.(model);

    try {
      if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

      console.log(`[${provider.id}] Attempt ${attempt}/${maxAttempts} with ${model}`);

      const result = await provider.call(pdfBlob, {
        model,
        prompt,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal,
        onStreamProgress,
      });

      return result;
    } catch (error: any) {
      if (error.name === 'AbortError') throw error;

      lastError = error;
      const reason = provider.summarizeError(error);
      const isOverloaded = provider.isOverloadedError(error);
      failureLog.push({ model, reason, overloaded: isOverloaded });
      console.warn(`[${provider.id}] Attempt ${attempt} failed (${model}): ${reason}`);

      const isRateLimit = provider.isRateLimitError(error);
      const repeatedRateLimit = isRateLimit && rateLimitHits.has(model);
      if (isRateLimit) rateLimitHits.add(model);
      const shouldSkip = provider.isPersistentError(error) || repeatedRateLimit;

      const nextModelInRotation = attempt < maxAttempts
        ? models[Math.floor(attempt / TRIES_PER_MODEL) % models.length]
        : null;

      if (shouldSkip && skipModels) {
        skipModels.add(model);
        const nextAvailable = models.find(m => m !== model && !skipModels.has(m)) ?? null;
        onError?.(model, reason, nextAvailable ? `skipping model, trying ${nextAvailable}` : 'skipping model, no models left');
        onModelSkip?.(model, nextAvailable, reason);
        console.log(`[${provider.id}] Model ${model} added to skip list (${reason})`);
      } else if (attempt < maxAttempts) {
        onError?.(model, reason, `retrying with ${nextModelInRotation}`);
      } else {
        onError?.(model, reason, 'no retries left');
      }

      if (attempt < maxAttempts) {
        const delaySec = shouldSkip ? 2 : isRateLimit ? 10 : isOverloaded ? 30 : attempt * 5;
        onRetry?.(attempt + 1, delaySec, isRateLimit ? 'rate_limited' : isOverloaded ? 'overloaded' : undefined);
        console.log(`[${provider.id}] Retrying with ${nextModelInRotation} in ${delaySec}s...`);
        await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
      }
    }
  }

  // ── Patience retries for transient overload (503) ───────────────────────
  // If every failure so far was an overloaded error, the service is
  // temporarily busy — keep retrying with longer delays instead of giving up.
  const allOverloaded = failureLog.length > 0 && failureLog.every(f => f.overloaded);
  if (allOverloaded) {
    const MAX_PATIENCE = 10;
    const PATIENCE_DELAYS = [30, 60, 60, 60, 60, 60, 60, 60, 60, 60]; // ~10 min total
    console.log(`[${provider.id}] All failures were overload (503). Entering patience retry mode.`);

    for (let p = 0; p < MAX_PATIENCE; p++) {
      if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

      const delaySec = PATIENCE_DELAYS[p] ?? 60;
      const model = models[p % models.length];
      onRetry?.(maxAttempts + p + 1, delaySec, 'overloaded');
      console.log(`[${provider.id}] Patience retry ${p + 1}/${MAX_PATIENCE}: waiting ${delaySec}s then trying ${model}`);
      await new Promise(resolve => setTimeout(resolve, delaySec * 1000));

      if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      onModelStart?.(model);

      try {
        const result = await provider.call(pdfBlob, {
          model,
          prompt,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          abortSignal,
          onStreamProgress,
        });
        return result;
      } catch (error: any) {
        if (error.name === 'AbortError') throw error;
        const reason = provider.summarizeError(error);
        const stillOverloaded = provider.isOverloadedError(error);
        console.warn(`[${provider.id}] Patience retry ${p + 1} failed (${model}): ${reason}`);
        onError?.(model, reason, stillOverloaded ? `still overloaded, will retry` : 'non-overload error, giving up');

        if (!stillOverloaded) {
          // A different kind of error surfaced — fall through to the normal failure path.
          break;
        }
      }
    }
  }

  const details = failureLog.map(f => `${f.model} (${f.reason})`).join(', ');
  throw new Error(`All models failed. Tried: ${details}`);
}

/**
 * Text-only version of callWithRetry — no PDF blob.
 * Used for markdown translation.
 */
export async function callTextWithRetry(
  prompt: string,
  options: OrchestratorCallOptions = {},
): Promise<ProviderResult> {
  const { onRetry, onModelSkip, onModelStart, onStreamProgress, onError, abortSignal, skipModels } = options;
  const provider: Provider = getActiveProvider();

  const allModels = getActiveModelPriority();
  const models = allModels.filter(m => !skipModels?.has(m));

  if (models.length === 0) {
    const skippedList = allModels.map(m => `${m} (previously failed)`).join(', ');
    throw new Error(`All models failed. Every model in your priority list was skipped due to prior errors: ${skippedList}`);
  }

  const TRIES_PER_MODEL = 2;
  const maxAttempts = models.length * TRIES_PER_MODEL;
  const failureLog: { model: string; reason: string; overloaded: boolean }[] = [];
  const rateLimitHits = new Set<string>();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const model = models[Math.floor((attempt - 1) / TRIES_PER_MODEL) % models.length];
    onModelStart?.(model);

    try {
      if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      console.log(`[${provider.id}] Text attempt ${attempt}/${maxAttempts} with ${model}`);

      return await provider.callText({
        model,
        prompt,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal,
        onStreamProgress,
      });
    } catch (error: any) {
      if (error.name === 'AbortError') throw error;

      const reason = provider.summarizeError(error);
      const isOverloaded = provider.isOverloadedError(error);
      failureLog.push({ model, reason, overloaded: isOverloaded });
      console.warn(`[${provider.id}] Text attempt ${attempt} failed (${model}): ${reason}`);

      const isRateLimit = provider.isRateLimitError(error);
      const repeatedRateLimit = isRateLimit && rateLimitHits.has(model);
      if (isRateLimit) rateLimitHits.add(model);
      const shouldSkip = provider.isPersistentError(error) || repeatedRateLimit;

      const nextModelInRotation = attempt < maxAttempts
        ? models[Math.floor(attempt / TRIES_PER_MODEL) % models.length]
        : null;

      if (shouldSkip && skipModels) {
        skipModels.add(model);
        const nextAvailable = models.find(m => m !== model && !skipModels.has(m)) ?? null;
        onError?.(model, reason, nextAvailable ? `skipping model, trying ${nextAvailable}` : 'skipping model, no models left');
        onModelSkip?.(model, nextAvailable, reason);
      } else if (attempt < maxAttempts) {
        onError?.(model, reason, `retrying with ${nextModelInRotation}`);
      } else {
        onError?.(model, reason, 'no retries left');
      }

      if (attempt < maxAttempts) {
        const delaySec = shouldSkip ? 2 : isRateLimit ? 10 : isOverloaded ? 30 : attempt * 5;
        onRetry?.(attempt + 1, delaySec, isRateLimit ? 'rate_limited' : isOverloaded ? 'overloaded' : undefined);
        await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
      }
    }
  }

  // Patience retries for transient overload (same logic as callWithRetry)
  const allOverloaded = failureLog.length > 0 && failureLog.every(f => f.overloaded);
  if (allOverloaded) {
    const MAX_PATIENCE = 10;
    const PATIENCE_DELAYS = [30, 60, 60, 60, 60, 60, 60, 60, 60, 60];
    console.log(`[${provider.id}] All text failures were overload. Entering patience retry mode.`);

    for (let p = 0; p < MAX_PATIENCE; p++) {
      if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

      const delaySec = PATIENCE_DELAYS[p] ?? 60;
      const model = models[p % models.length];
      onRetry?.(maxAttempts + p + 1, delaySec, 'overloaded');
      await new Promise(resolve => setTimeout(resolve, delaySec * 1000));

      if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      onModelStart?.(model);

      try {
        return await provider.callText({
          model,
          prompt,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          abortSignal,
          onStreamProgress,
        });
      } catch (error: any) {
        if (error.name === 'AbortError') throw error;
        const reason = provider.summarizeError(error);
        const stillOverloaded = provider.isOverloadedError(error);
        onError?.(model, reason, stillOverloaded ? `still overloaded, will retry` : 'non-overload error, giving up');
        if (!stillOverloaded) break;
      }
    }
  }

  const details = failureLog.map(f => `${f.model} (${f.reason})`).join(', ');
  throw new Error(`All models failed. Tried: ${details}`);
}
