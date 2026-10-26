import { createServer, type Server, type ServerResponse } from 'node:http';

function readBody(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : {};
  } catch {
    return {};
  }
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * An OpenAI-compatible chat endpoint that answers every call with `content` and reports `usage`
 * for it. Without `usage` it answers but reports nothing, like a provider that omits usage.
 */
export async function startModelEndpointStub(options: {
  usage?: { prompt_tokens: number; completion_tokens: number };
  content?: string;
  /** Answers a request with this error status instead of `content`, e.g. a provider that refuses a field. */
  refuse?: ((body: Record<string, unknown>) => number | undefined) | undefined;
}): Promise<{ server: Server; baseUrl: string; requests: Record<string, unknown>[] }> {
  const { usage, content = 'hello', refuse } = options;
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      respond(readBody(Buffer.concat(chunks).toString('utf8')), res);
    });
  });
  function respond(body: Record<string, unknown>, res: ServerResponse): void {
    requests.push(body);
    const refusedStatus = refuse?.(body);
    if (refusedStatus !== undefined) {
      res.writeHead(refusedStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unsupported field: reasoning_effort', type: 'invalid_request' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const base = { id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1, model: 'stub' };
    res.write(sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }));
    res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    if (usage !== undefined) {
      res.write(
        sse({ ...base, choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }),
      );
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the model stub did not bind to a TCP port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port.toString()}/v1`, requests };
}
