import type { AgentContextProcessorOutput } from '@truefoundry/trueforge-core/core';
import path from 'node:path';
import winston from 'winston';

import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { memoryCapability } from '../../../../src/runtime/memory/memoryCapability';
import { serverMemoryConfig } from '../../../../src/runtime/memory/memorySettings';
import {
  askAbout,
  HandChosenModel,
  makeVault,
  ownBullet,
  warmLog,
  writeKitNotes,
  writeStatementPage,
} from './statementTestKit';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('one meaning gate for each message', () => {
  it('is worked out once and the log and the pages get that same answer', async () => {
    const model = new HandChosenModel();
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'nora',
      title: 'Nora',
      summary: 'My wife.',
      sections: {
        Now: [0, 1, 2].map(topic =>
          ownBullet({ text: `Likes topic${String(topic)} a lot.`, id: `f_0${String(topic)}` }),
        ),
      },
    });
    await writeKitNotes({
      vaultDir,
      notes: [2, 3, 4, 5].map(topic => ({ day: today(), text: `Remember topic${String(topic)}` })),
    });
    const embeddings = await warmLog({ vaultDir, model });
    const client = new MarkdownMemoryClient({
      baseDir: path.dirname(vaultDir),
      namespace: path.basename(vaultDir),
      embeddings: () => embeddings,
    });
    const meaningGate = jest.spyOn(client, 'meaningGate');
    const recall = jest.spyOn(client, 'recall');
    const loadPages = jest.spyOn(client, 'loadPages');
    const embedQueries = jest.spyOn(model, 'embedQueries');
    const message = askAbout({ topic: 2, closeness: 1 });

    const capability = memoryCapability({
      client,
      config: serverMemoryConfig(),
      logger: winston.createLogger({ silent: true }),
      sessionId: 'chat-1',
      previousTurnId: null,
      timeZone: 'UTC',
    });
    const processor = capability.preLLMProcessors?.[0];
    if (processor === undefined) {
      throw new Error('The memory capability has no step that runs before the model.');
    }
    const events: AgentContextProcessorOutput[] = [];
    for await (const event of processor.processPreLLM({
      threadId: 'main',
      currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
      context: [{ role: 'user', content: message }],
    })) {
      events.push(event);
    }

    expect(meaningGate).toHaveBeenCalledTimes(1);
    const gate = await meaningGate.mock.results[0]?.value;
    expect(gate).toMatchObject({ state: 'judged', open: true });
    expect(recall).toHaveBeenCalledTimes(1);
    expect(loadPages).toHaveBeenCalledTimes(1);
    expect(recall.mock.calls[0]?.[0].gate).toBe(gate);
    expect(loadPages.mock.calls[0]?.[0].gate).toBe(gate);
    // The message is embedded once, for that one answer.
    expect(embedQueries.mock.calls.filter(([texts]) => texts.includes(message))).toHaveLength(1);
    const block = JSON.stringify(events);
    expect(block).toContain('Likes topic2 a lot.');
    expect(block).toContain('Remember topic2');
  });
});
