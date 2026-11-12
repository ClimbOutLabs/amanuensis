import type { AgentContextProcessorOutput, AgentThreadExecutionContext } from '@truefoundry/trueforge-core/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import winston from 'winston';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { memoryCapability, type MemoryConfig } from '../../../../src/runtime/memory/memoryCapability';

const CONFIG: MemoryConfig = {
  recallMaxTokens: 2048,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  preRecallGateEnabled: false,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  pages: { maxCount: 6, maxTokens: 1500 },
};

describe('recall and the learned profile copy', () => {
  it('drops a copy of the learned profile and keeps other notes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'recall-copy-'));
    try {
      const client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'default' });
      // The copy as an earlier version saved it.
      await client.retain({
        items: [
          {
            content: 'Rivera keeps bees on the allotment and prefers oat milk.',
            timestamp: '2026-09-01T12:00:00.000Z',
            document_id: 'aman-learned-profile-0123456789abcdef',
            context: 'Learned user profile',
            metadata: { source: 'aman-profile-learning', replace_document: 'true', origin: 'user_stated' },
          },
          {
            content: 'Rivera has a plot at the allotment.',
            timestamp: '2026-09-01T12:00:00.000Z',
            document_id: 'note-1',
            metadata: { replace_document: 'true', origin: 'user_stated' },
          },
        ],
        operationId: '5b0c1c3e-1111-5111-8111-111111111111',
        timeoutMs: 1_000,
      });

      const capability = memoryCapability({
        client,
        config: CONFIG,
        logger: winston.createLogger({ silent: true }),
        sessionId: 's2',
        previousTurnId: null,
      });
      const processor = capability.preLLMProcessors?.[0];
      if (!processor) {
        throw new Error('expected a preLLM processor');
      }
      const execution: Readonly<AgentThreadExecutionContext> = {
        threadId: 'main',
        currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
        context: [{ role: 'user', content: 'Do bees like oat milk on the allotment?' }],
      };
      const events: AgentContextProcessorOutput[] = [];
      for await (const event of processor.processPreLLM(execution)) {
        events.push(event);
      }
      const block = JSON.stringify(events);
      expect(block).not.toContain('keeps bees on the allotment');
      expect(block).toContain('has a plot at the allotment');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
