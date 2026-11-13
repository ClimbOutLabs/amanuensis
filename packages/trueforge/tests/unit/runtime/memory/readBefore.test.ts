import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ILLM } from '@truefoundry/trueforge-core/core';
import winston from 'winston';

import { type IModelProviderStore } from '../../../../src/db/modelProviderStore';
import { summarizeTurnContent } from '../../../../src/runtime/memory/memorySummarize';
import {
  MAX_READ_BEFORE,
  noteReadBefore,
  questionFingerprint,
  wasReadBefore,
} from '../../../../src/runtime/memory/readBefore';
import { vaultStateDir } from '../../../../src/runtime/memory/vaultLock';
import { discardedModelUsage } from '../../../fixtures/discardedModelUsage';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';

const NOTHING = '{"facts": []}';

/** A model that answers each question with the next reply, then repeats the last, and counts what it was asked. */
function modelAnswering(...replies: string[]): { llm: ILLM; asked: () => number } {
  let calls = 0;
  const llm: ILLM = {
    create(): ReturnType<ILLM['create']> {
      throw new Error('streaming is not used by memory summarization');
    },
    createNonStream: async () => {
      const content = replies[Math.min(calls, replies.length - 1)] ?? '';
      calls += 1;
      return {
        output: { role: 'assistant', content },
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        finish_reason: 'stop',
      };
    },
  };
  return { llm, asked: () => calls };
}

function unusedModelProviderStore(): IModelProviderStore {
  return {
    managedElsewhere: false,
    listProviders: jest.fn(),
    getProvider: jest.fn(),
    getProviderForUpdate: jest.fn(),
    createProvider: jest.fn(),
    upsertProvider: jest.fn(),
    listModels: jest.fn(),
    deleteProvider: jest.fn(),
  };
}

describe('reading each thing once', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'read-before-'));
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  function ask({
    llm,
    userText = 'Scan the news for AI chip stories.',
    assistantText = 'Here are the stories.',
    turnDate = '2026-11-09T08:00:00.000Z',
    model = 'test/reads-once',
    withVault = true,
  }: {
    llm: ILLM;
    userText?: string;
    assistantText?: string;
    turnDate?: string;
    model?: string;
    withVault?: boolean;
  }) {
    return summarizeTurnContent({
      userText,
      assistantText,
      turnDate,
      tenantId: 'tenant-1',
      modelProviderStore: unusedModelProviderStore(),
      summarizationModelFqn: model,
      tokenFactoryBudget: uncappedTokenFactoryBudget,
      modelUsage: discardedModelUsage,
      logger: winston.createLogger({ silent: true }),
      vaultDir: withVault ? vaultDir : undefined,
      resolveLlm: async () => llm,
    });
  }

  it('does not ask again about words that held nothing, on any later day', async () => {
    const { llm, asked } = modelAnswering(NOTHING);
    expect(await ask({ llm })).toEqual({ status: 'nothing_to_keep' });
    for (const day of ['10', '11', '12', '13']) {
      expect(await ask({ llm, turnDate: `2026-11-${day}T08:00:00.000Z` })).toEqual({ status: 'nothing_to_keep' });
    }
    expect(asked()).toBe(1);
  });

  it('asks once more when the words change', async () => {
    const { llm, asked } = modelAnswering(NOTHING);
    await ask({ llm });
    await ask({ llm, userText: 'Scan the news for AI chip stories and email me a summary.' });
    expect(asked()).toBe(2);
  });

  it('asks again when a short answer follows a different question', async () => {
    const { llm, asked } = modelAnswering(NOTHING);
    await ask({ llm, userText: 'yes', assistantText: 'Shall I book the table for seven?' });
    await ask({ llm, userText: 'yes', assistantText: 'Shall I book the table for seven?' });
    await ask({ llm, userText: 'yes', assistantText: 'Is Wendy still allergic to shellfish?' });
    expect(asked()).toBe(2);
  });

  it('asks again about words that held a fact, because the answer is written for its day', async () => {
    const { llm, asked } = modelAnswering('{"facts": ["The person wants the fence painted before summer."]}');
    const text = 'I want the fence painted before summer.';
    expect((await ask({ llm, userText: text })).status).toBe('summarized');
    expect((await ask({ llm, userText: text })).status).toBe('summarized');
    expect(asked()).toBe(2);
  });

  it('does not remember an answer it could not read', async () => {
    const { llm, asked } = modelAnswering('not an answer', NOTHING);
    expect((await ask({ llm })).status).toBe('failed');
    expect(await ask({ llm })).toEqual({ status: 'nothing_to_keep' });
    expect(asked()).toBe(2);
  });

  it('asks again after the model was changed', async () => {
    const { llm, asked } = modelAnswering(NOTHING);
    await ask({ llm });
    await ask({ llm, model: 'test/another-model' });
    expect(asked()).toBe(2);
  });

  it('asks every time when there is no vault to remember in', async () => {
    const { llm, asked } = modelAnswering(NOTHING);
    await ask({ llm, withVault: false });
    await ask({ llm, withVault: false });
    expect(asked()).toBe(2);
  });

  it('keeps a fingerprint only, never the words', async () => {
    const { llm } = modelAnswering(NOTHING);
    await ask({ llm, userText: 'Zorblax says thanks.' });
    const stored = await readFile(path.join(vaultStateDir(vaultDir), 'read-before.json'), 'utf8');
    expect(stored).not.toContain('Zorblax');
    expect(stored).toMatch(/^\{"nothing_to_keep":\["[0-9a-f]{64}"\]\}$/);
  });

  it('drops the oldest fingerprints beyond its limit and reads a broken file as empty', async () => {
    for (let index = 0; index < 3; index += 1) {
      await noteReadBefore({ vaultDir, fingerprint: `f${String(index)}` });
    }
    await noteReadBefore({ vaultDir, fingerprint: 'f1' });
    expect(await wasReadBefore({ vaultDir, fingerprint: 'f0' })).toBe(true);
    expect(await wasReadBefore({ vaultDir, fingerprint: 'unknown' })).toBe(false);
    expect(MAX_READ_BEFORE).toBeGreaterThan(100);
    expect(await wasReadBefore({ vaultDir: path.join(vaultDir, 'missing'), fingerprint: 'f0' })).toBe(false);
  });

  it('tells questions apart by the model and by every word sent', () => {
    const messages = [{ role: 'user', content: 'thanks' }];
    const one = questionFingerprint({ modelFqn: 'a', messages });
    expect(questionFingerprint({ modelFqn: 'a', messages })).toBe(one);
    expect(questionFingerprint({ modelFqn: 'b', messages })).not.toBe(one);
    expect(questionFingerprint({ modelFqn: 'a', messages: [{ role: 'user', content: 'thanks!' }] })).not.toBe(one);
  });
});
