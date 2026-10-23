import { z } from '@hono/zod-openapi';
import type { VercelAIProviderConfig } from '@truefoundry/trueforge-core/core';

const LOOKUP_TIMEOUT_MS = 3_000;
/** A server's limit rarely changes, and a server that does not report one is not asked again on every turn. */
const LOOKUP_CACHE_TTL_MS = 10 * 60_000;

const ReportedLengthSchema = z.number().int().positive().optional().catch(undefined);

/**
 * The context-length fields self-hosted OpenAI-compatible servers put on a `/models` entry:
 * vLLM and SGLang `max_model_len`, LM Studio `max_context_length`, and gateways that pass on
 * `context_length` or `context_window`.
 */
const ServedModelSchema = z.object({
  id: z.string(),
  max_model_len: ReportedLengthSchema,
  max_context_length: ReportedLengthSchema,
  context_length: ReportedLengthSchema,
  context_window: ReportedLengthSchema,
});

const ServedModelListSchema = z.object({ data: z.array(z.unknown()) });

/** The context length a `/models` response reports for one model, or undefined when it reports none. */
export function reportedContextLength({ body, modelId }: { body: unknown; modelId: string }): number | undefined {
  const list = ServedModelListSchema.safeParse(body);
  if (!list.success) {
    return undefined;
  }
  for (const entry of list.data.data) {
    const model = ServedModelSchema.safeParse(entry);
    if (model.success && model.data.id === modelId) {
      const { max_model_len, max_context_length, context_length, context_window } = model.data;
      return max_model_len ?? max_context_length ?? context_length ?? context_window;
    }
  }
  return undefined;
}

const lookups = new Map<string, { value: number | undefined; expiresAt: number }>();

/**
 * Asks a self-hosted server for the context length it actually serves the model with. Any failure
 * (no answer, an error, no limit in the reply) reads as "not reported"; it never fails the turn.
 */
async function lookupServerContextLength({
  providerConfig,
  fetchImpl,
}: {
  providerConfig: VercelAIProviderConfig;
  fetchImpl: typeof fetch;
}): Promise<number | undefined> {
  const { baseUrl } = providerConfig;
  if (providerConfig.provider.type !== 'custom' || baseUrl === undefined) {
    return undefined;
  }
  const key = `${baseUrl}\n${providerConfig.model.id}`;
  const cached = lookups.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  let value: number | undefined;
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: {
        ...providerConfig.headers,
        ...(providerConfig.apiKey === '' ? {} : { authorization: `Bearer ${providerConfig.apiKey}` }),
      },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    value = response.ok
      ? reportedContextLength({ body: await response.json(), modelId: providerConfig.model.id })
      : undefined;
  } catch {
    value = undefined;
  }
  lookups.set(key, { value, expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS });
  return value;
}

/**
 * The context length a turn is sized against: the limit a self-hosted server reports for the model,
 * else the one configured on the model, else undefined (unknown). The server's own limit wins
 * because it is what the server will actually accept.
 */
export async function resolveModelContextLength({
  providerConfig,
  configuredContextLength,
  fetchImpl = fetch,
}: {
  providerConfig: VercelAIProviderConfig;
  configuredContextLength: number | undefined;
  fetchImpl?: typeof fetch;
}): Promise<number | undefined> {
  return (await lookupServerContextLength({ providerConfig, fetchImpl })) ?? configuredContextLength;
}

/** Forgets every looked-up limit, so tests start clean. */
export function clearModelContextLengthCache(): void {
  lookups.clear();
}
