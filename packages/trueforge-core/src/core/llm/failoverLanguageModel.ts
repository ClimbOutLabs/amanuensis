import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';
import { APICallError } from 'ai';
import type { Logger } from 'winston';
import { extractErrorLogFields } from '../util/errorLogFields';

/**
 * Options for {@link withFailover}. Public surface, so optional fields use `?`.
 */
export interface FailoverLanguageModelOptions {
  /** The model to try first. */
  primary: LanguageModelV4;
  /** The model to use when the primary fails before producing output. */
  secondary: LanguageModelV4;
  logger?: Logger | undefined;
  /** Called once when a request actually falls over to the secondary model. */
  onFallback?: ((error: unknown) => void) | undefined;
}

/**
 * True when a failed primary call should be retried on the secondary model.
 *
 * Failover covers the endpoint being down or overloaded: connection failures (no
 * response received, so no status code), timeouts, 429, 409, and 5xx. Failover never
 * masks caller or configuration problems: 400/401/403/404 and other client errors
 * propagate to the caller unchanged, so a bad API key or model id surfaces loudly
 * instead of silently answering from the wrong model. Caller cancellation is never
 * retried either.
 */
export function isFailoverRetryable(error: unknown): boolean {
  if (APICallError.isInstance(error)) {
    // The SDK sometimes wraps the abort as the cause of an API error.
    if (isAbortError(error.cause)) {
      return false;
    }
    return error.statusCode === undefined || error.isRetryable;
  }
  return !isAbortError(error);
}

/** Name-based check: DOMException aborts are not `instanceof Error` in Node. */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'name') === 'AbortError';
}

async function withFallback<Result>(
  options: FailoverLanguageModelOptions,
  callOptions: LanguageModelV4CallOptions,
  invoke: (model: LanguageModelV4) => PromiseLike<Result>,
): Promise<Result> {
  const { primary, secondary, logger, onFallback } = options;
  if (callOptions.abortSignal?.aborted) {
    return invoke(primary);
  }
  try {
    return await invoke(primary);
  } catch (error) {
    if (callOptions.abortSignal?.aborted || !isFailoverRetryable(error)) {
      throw error;
    }
    logger?.warn('Primary model call failed before producing output; failing over to secondary model', {
      primaryProvider: primary.provider,
      primaryModelId: primary.modelId,
      secondaryProvider: secondary.provider,
      secondaryModelId: secondary.modelId,
      ...extractErrorLogFields(error),
    });
    onFallback?.(error);
    return invoke(secondary);
  }
}

/**
 * Wraps two language models so a request that fails on the primary before producing
 * any output is retried once on the secondary.
 *
 * Failover happens only inside `doGenerate`/`doStream`, i.e. before the first output
 * chunk exists. A failure after streaming has started is never retried on the
 * secondary: restarting would duplicate visible output or repeat tool calls. Caller
 * cancellation is never retried either.
 *
 * The wrapper reports the primary's `provider`/`modelId`; the `onFallback` callback
 * is the signal that the secondary actually served a request.
 */
export function withFailover(options: FailoverLanguageModelOptions): LanguageModelV4 {
  const { primary } = options;
  return {
    specificationVersion: 'v4',
    provider: primary.provider,
    modelId: primary.modelId,
    supportedUrls: primary.supportedUrls,
    doGenerate: (callOptions: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> =>
      withFallback(options, callOptions, model => model.doGenerate(callOptions)),
    doStream: (callOptions: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> =>
      withFallback(options, callOptions, model => model.doStream(callOptions)),
  };
}
