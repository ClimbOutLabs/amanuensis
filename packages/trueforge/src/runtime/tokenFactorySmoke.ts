import { z } from '@hono/zod-openapi';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DETAIL_LIMIT = 200;

const ModelListSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

const ToolProbeCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          tool_calls: z.array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) })).nullish(),
        }),
      }),
    )
    .min(1),
});

/** One line of the live Token Factory smoke test. */
export interface SmokeCheck {
  ok: boolean;
  label: string;
  detail: string;
}

export function formatSmokeLine(check: SmokeCheck): string {
  return `${check.ok ? 'ok  ' : 'fail'} ${check.label}: ${check.detail}`;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_LIMIT ? `${flat.slice(0, DETAIL_LIMIT)}...` : flat;
}

/** Keeps the key out of anything printed, even if an upstream error body echoes it. */
function describeFailure({ error, apiKey }: { error: unknown; apiKey: string }): string {
  // Node's fetch reports every network failure as "fetch failed"; the reason is on the cause.
  const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
  const message = error instanceof Error ? error.message : String(error);
  return clip(`${message}${cause}`.replaceAll(apiKey, '[redacted]'));
}

async function readResponse({
  response,
  apiKey,
}: {
  response: Response;
  apiKey: string;
}): Promise<{ ok: true; body: unknown } | { ok: false; detail: string }> {
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${String(response.status)} ${clip(text.replaceAll(apiKey, '[redacted]'))}` };
  }
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch (error) {
    return { ok: false, detail: `response was not JSON (${describeFailure({ error, apiKey })})` };
  }
}

async function listModelIds({
  baseUrl,
  apiKey,
  fetchImpl,
  timeoutMs,
}: {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<{ checks: SmokeCheck[]; ids: Set<string> | undefined }> {
  const label = 'GET /models';
  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const read = await readResponse({ response, apiKey });
    if (!read.ok) {
      return { checks: [{ ok: false, label, detail: read.detail }], ids: undefined };
    }
    const parsed = ModelListSchema.safeParse(read.body);
    if (!parsed.success) {
      return { checks: [{ ok: false, label, detail: 'response has no model list' }], ids: undefined };
    }
    const ids = new Set(parsed.data.data.map(model => model.id));
    return { checks: [{ ok: true, label, detail: `${String(ids.size)} models` }], ids };
  } catch (error) {
    return { checks: [{ ok: false, label, detail: describeFailure({ error, apiKey }) }], ids: undefined };
  }
}

async function probeToolCall({
  baseUrl,
  apiKey,
  model,
  fetchImpl,
  timeoutMs,
}: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<SmokeCheck> {
  const label = `tool call ${model}`;
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'What is the weather in Paris right now? Use the get_weather tool.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Current weather for a city.',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string', description: 'City name.' } },
                required: ['city'],
              },
            },
          },
        ],
        tool_choice: 'auto',
        temperature: 0,
        max_tokens: 512,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const read = await readResponse({ response, apiKey });
    if (!read.ok) {
      return { ok: false, label, detail: read.detail };
    }
    const parsed = ToolProbeCompletionSchema.safeParse(read.body);
    const call = parsed.success ? parsed.data.choices[0]?.message.tool_calls?.[0]?.function : undefined;
    if (call === undefined) {
      return { ok: false, label, detail: 'the model answered without a tool_calls entry' };
    }
    if (call.name !== 'get_weather') {
      return { ok: false, label, detail: `the model called ${call.name} instead of get_weather` };
    }
    return { ok: true, label, detail: `returned get_weather(${clip(call.arguments)})` };
  } catch (error) {
    return { ok: false, label, detail: describeFailure({ error, apiKey }) };
  }
}

/**
 * Live checks against the real Token Factory endpoint: the model list contains every configured
 * model, and each configured model answers a `get_weather` function-calling probe with `tool_calls`.
 * Returns plain results; printing and the exit code belong to the caller.
 */
export async function runTokenFactorySmoke({
  apiKey,
  baseUrl,
  models,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: {
  apiKey: string;
  baseUrl: string;
  models: string[];
  fetchImpl?: typeof fetch;
  /** Per request; callers with a tighter overall budget pass a smaller one. */
  timeoutMs?: number;
}): Promise<SmokeCheck[]> {
  const listed = await listModelIds({ baseUrl, apiKey, fetchImpl, timeoutMs });
  const checks = [...listed.checks];
  for (const model of models) {
    if (listed.ids !== undefined) {
      checks.push(
        listed.ids.has(model)
          ? { ok: true, label: `model listed ${model}`, detail: 'present in /models' }
          : { ok: false, label: `model listed ${model}`, detail: 'not in /models; check the model id' },
      );
    }
    checks.push(await probeToolCall({ baseUrl, apiKey, model, fetchImpl, timeoutMs }));
  }
  return checks;
}
