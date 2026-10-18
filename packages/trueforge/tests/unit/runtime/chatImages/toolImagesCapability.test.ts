import type { ToolCallResult } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';

import { toolImagesCapability } from '../../../../src/runtime/chatImages/toolImagesCapability';
import { FakeTurnArtifactStore } from '../../../fixtures/fakeTurnArtifactStore';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function result(input: { id: string; images: ToolCallResult['images']; failure?: boolean }): ToolCallResult {
  return {
    message: { role: 'tool', tool_call_id: input.id, content: 'Attachment downloaded' },
    rawContent: 'Attachment downloaded',
    images: input.images,
    toolCallInfo: undefined,
    screen: undefined,
    failure: input.failure ?? false,
    isStructuredContent: false,
    completedAt: '2026-10-17T00:00:00.000Z',
    memoized: false,
    repeatCount: 1,
    blockedPrivateFallback: false,
    repeatedSideEffect: false,
    verificationReceiptCandidate: undefined,
    disposition: 'executed_ok',
    remediation: undefined,
    admissionProvenance: { source: 'automatic' },
  };
}

async function process(results: ToolCallResult[]) {
  const store = new FakeTurnArtifactStore();
  const capability = toolImagesCapability({
    store,
    tenantId: 'default',
    sessionId: 's1',
    turnId: 't1',
    logger: createLogger({ silent: true }),
  });
  const processor = capability.toolResponseProcessors?.[0];
  if (processor === undefined) {
    throw new Error('expected a tool response processor');
  }
  await processor.process(results, {
    threadId: 'main',
    currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
    context: [],
  });
  return [...store.records.values()].map(record => record.path);
}

describe('toolImagesCapability', () => {
  it('keeps allow-listed images a tool returned as turn artifacts', async () => {
    await expect(
      process([
        result({
          id: 'mail-1',
          images: [
            { mime: 'image/png', data: PNG },
            { mime: 'image/jpeg', data: PNG },
          ],
        }),
      ]),
    ).resolves.toEqual(['tool_images/mail-1/image-1.png', 'tool_images/mail-1/image-2.jpg']);
  });

  it('drops SVG and other types, and anything from a failed call', async () => {
    await expect(
      process([
        result({ id: 'a', images: [{ mime: 'image/svg+xml', data: Buffer.from('<svg/>') }] }),
        result({ id: 'b', images: [{ mime: 'image/png', data: PNG }], failure: true }),
      ]),
    ).resolves.toEqual([]);
  });
});
