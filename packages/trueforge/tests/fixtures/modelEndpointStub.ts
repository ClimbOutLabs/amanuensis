import { createServer, type Server } from 'node:http';

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** An OpenAI-compatible chat endpoint that answers every call with `content` and reports `usage` for it. */
export async function startModelEndpointStub(options: {
  usage: { prompt_tokens: number; completion_tokens: number };
  content?: string;
}): Promise<{ server: Server; baseUrl: string }> {
  const { usage, content = 'hello' } = options;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const base = { id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1, model: 'stub' };
    res.write(sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }));
    res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    res.write(
      sse({ ...base, choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }),
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the model stub did not bind to a TCP port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port.toString()}/v1` };
}
