/**
 * End-to-end failover through the real stack: `VercelAILLM` with a dead primary
 * endpoint and a stub OpenAI-compatible server as the Token Factory fallback.
 * Runs the actual user journey (local down -> cloud answers), not a narration of it.
 */
import { createServer, type Server } from 'node:http';
import type { VercelAIProviderConfig } from '../../../src/core/llm/VercelAILLM';
import { VercelAILLM } from '../../../src/core/llm/VercelAILLM';
import { makeSilentLogger } from '../harnessMocks';

function sseChunk(content: string, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-stub',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'stub-model',
    choices: [{ index: 0, delta: content === '' ? {} : { role: 'assistant', content }, finish_reason: finishReason }],
  })}\n\n`;
}

async function startStubServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(sseChunk('hello from fallback', null));
    res.write(sseChunk('', 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub server did not bind to a TCP port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function providerConfig(overrides: {
  type: VercelAIProviderConfig['provider']['type'];
  baseUrl: string;
  modelId: string;
}): VercelAIProviderConfig {
  return {
    provider: { type: overrides.type, name: overrides.type },
    model: { id: overrides.modelId, name: overrides.modelId },
    name: `${overrides.type}/${overrides.modelId}`,
    baseUrl: overrides.baseUrl,
    apiKey: 'none',
    headers: {},
  };
}

describe('VercelAILLM Token Factory failover journey', () => {
  it('answers from the fallback when the primary endpoint is down', async () => {
    const { server, baseUrl } = await startStubServer();
    try {
      const llm = new VercelAILLM({
        providerConfig: providerConfig({ type: 'custom', baseUrl: 'http://127.0.0.1:1/v1', modelId: 'dead' }),
        fallbackProviderConfig: providerConfig({ type: 'tokenfactory', baseUrl, modelId: 'stub-model' }),
        logger: makeSilentLogger(),
      });
      const result = await llm.createNonStream({ messages: [{ role: 'user', content: 'hi' }] });
      expect(result.output.content).toContain('hello from fallback');
      expect(result.finish_reason).toBe('stop');
    } finally {
      server.close();
    }
  });

  it('reports each request that fell over, and none that the primary answered', async () => {
    const { server, baseUrl } = await startStubServer();
    try {
      const onFallback = jest.fn();
      const down = new VercelAILLM({
        providerConfig: providerConfig({ type: 'custom', baseUrl: 'http://127.0.0.1:1/v1', modelId: 'dead' }),
        fallbackProviderConfig: providerConfig({ type: 'tokenfactory', baseUrl, modelId: 'stub-model' }),
        logger: makeSilentLogger(),
        onFallback,
      });
      await down.createNonStream({ messages: [{ role: 'user', content: 'hi' }] });
      await down.createNonStream({ messages: [{ role: 'user', content: 'again' }] });
      expect(onFallback).toHaveBeenCalledTimes(2);

      const healthy = new VercelAILLM({
        providerConfig: providerConfig({ type: 'custom', baseUrl, modelId: 'stub-model' }),
        fallbackProviderConfig: providerConfig({
          type: 'tokenfactory',
          baseUrl: 'http://127.0.0.1:1/v1',
          modelId: 'x',
        }),
        logger: makeSilentLogger(),
        onFallback,
      });
      await healthy.createNonStream({ messages: [{ role: 'user', content: 'hi' }] });
      expect(onFallback).toHaveBeenCalledTimes(2);
    } finally {
      server.close();
    }
  });

  it('still works with no fallback configured', async () => {
    const { server, baseUrl } = await startStubServer();
    try {
      const llm = new VercelAILLM({
        providerConfig: providerConfig({ type: 'tokenfactory', baseUrl, modelId: 'stub-model' }),
        logger: makeSilentLogger(),
      });
      const result = await llm.createNonStream({ messages: [{ role: 'user', content: 'hi' }] });
      expect(result.output.content).toContain('hello from fallback');
    } finally {
      server.close();
    }
  });

  it('proves the control: a dead primary with no fallback throws', async () => {
    const llm = new VercelAILLM({
      providerConfig: providerConfig({ type: 'custom', baseUrl: 'http://127.0.0.1:1/v1', modelId: 'dead' }),
      logger: makeSilentLogger(),
    });
    await expect(llm.createNonStream({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
  });
});
