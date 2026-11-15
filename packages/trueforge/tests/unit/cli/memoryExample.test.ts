import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { InternalEventType } from '@truefoundry/trueforge-core/core';
import { z } from 'zod';

import { UsageError } from '../../../src/cli/io';
import { createMemoryExample } from '../../../src/cli/memoryExample';
import { EXAMPLE_NOTES } from '../../../src/cli/memoryExample/notes';
import { replaceMemoryWithExample } from '../../../src/cli/memoryExample/replace';
import { MarkdownMemoryClient } from '../../../src/runtime/memory/markdownMemoryClient';
import { memoryCapability } from '../../../src/runtime/memory/memoryCapability';
import { collect, DEFAULT_CONFIG, makeExecution, makeLogger } from '../runtime/memory/memoryCapabilityTestKit';
import { fakeIo } from './fakeIo';

const ResultSchema = z.object({ notes: z.number(), set_aside: z.string().nullable() });
const NOW = new Date('2026-11-13T20:00:00.000Z');
const NAMESPACE = 'default';

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'aman-memory-example-'));
});

afterEach(async () => {
  jest.useRealTimers();
  await rm(baseDir, { recursive: true, force: true });
});

function command() {
  return createMemoryExample({
    now: () => NOW,
    replace: ({ now }) => replaceMemoryWithExample({ baseDir, namespace: NAMESPACE, now }),
  });
}

async function run(): Promise<z.infer<typeof ResultSchema>> {
  const io = fakeIo();
  expect(await command()({ args: ['--replace'], io })).toBe(0);
  return ResultSchema.parse(JSON.parse(io.out.join('')));
}

/** The block one turn would show the model for a message, read from the vault the command wrote. */
async function blockFor(message: string): Promise<string> {
  jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'setInterval'] });
  const capability = memoryCapability({
    client: new MarkdownMemoryClient({ baseDir, namespace: NAMESPACE }),
    config: DEFAULT_CONFIG,
    logger: makeLogger(),
    sessionId: 'a-new-chat',
    previousTurnId: null,
  });
  const processor = capability.preLLMProcessors?.[0];
  if (processor === undefined) {
    throw new Error('expected a preLLM processor');
  }
  const events = await collect(processor.processPreLLM(makeExecution([{ role: 'user', content: message }])));
  for (const event of events) {
    if (event.type === InternalEventType.PASSTHROUGH && event.event.type === 'aman.memory.recall') {
      return event.event.injected_block ?? '';
    }
  }
  throw new Error('expected a recall event');
}

describe('memory-example', () => {
  it('changes nothing without --replace and says how to go ahead', async () => {
    await mkdir(path.join(baseDir, NAMESPACE, 'memory'), { recursive: true });
    await writeFile(path.join(baseDir, NAMESPACE, 'memory', '2026-11-01.md'), '## 10:00\n\nMine.\n');
    await expect(command()({ args: [], io: fakeIo() })).rejects.toThrow(UsageError);
    await expect(command()({ args: [], io: fakeIo() })).rejects.toThrow('Run it again with --replace');
    expect(await readdir(baseDir)).toEqual([NAMESPACE]);
  });

  it('moves the memory that was there aside, whole, and leaves other folders alone', async () => {
    const mine = '## 10:00\n\nMine.\n';
    await mkdir(path.join(baseDir, NAMESPACE, 'memory'), { recursive: true });
    await writeFile(path.join(baseDir, NAMESPACE, 'memory', '2026-11-01.md'), mine);
    await mkdir(path.join(baseDir, `${NAMESPACE}__persona_Chef`, 'memory'), { recursive: true });
    await mkdir(path.join(baseDir, '.embedding-model'));

    const result = await run();

    expect(result.set_aside).not.toBeNull();
    const aside = result.set_aside ?? '';
    expect(await readFile(path.join(aside, NAMESPACE, 'memory', '2026-11-01.md'), 'utf8')).toBe(mine);
    expect((await readdir(aside)).sort()).toEqual([NAMESPACE, `${NAMESPACE}__persona_Chef`]);
    expect(
      (await readdir(baseDir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort(),
    ).toEqual(['.embedding-model', '.set-aside', NAMESPACE]);
    expect(await readdir(path.join(baseDir, NAMESPACE, 'memory'))).not.toContain('2026-11-01.md');
  });

  it('writes every example note, dated across about two years back from today', async () => {
    const result = await run();
    expect(result).toEqual({ notes: EXAMPLE_NOTES.length, set_aside: null });

    const days = (await readdir(path.join(baseDir, NAMESPACE, 'memory'))).filter(name => name.endsWith('.md')).sort();
    expect(days[0]).toBe('2024-11-18.md');
    expect(days[days.length - 1]).toBe('2026-11-12.md');
    const listed = await new MarkdownMemoryClient({ baseDir, namespace: NAMESPACE }).listEntries({
      namespace: NAMESPACE,
      timeoutMs: 10_000,
    });
    expect(listed.ok && listed.entries.length).toBe(EXAMPLE_NOTES.length);
  });

  it('shows an old note to the model with its day, its age and who said it', async () => {
    await run();
    const lines = (await blockFor('Should I wear my Versace jacket tonight?')).split('\n');
    expect(lines).toContain(
      '[2025-03-13, 20 months ago, said by the person] My Versace jacket has a hole in the sleeve.',
    );
  });

  it('shows the old and the new tax advice as found in mail, each with its age', async () => {
    await run();
    const block = await blockFor('Should I file my taxes early, what did the CPA Dana Whitfield say?');
    expect(block).toContain('[2024-11-27, 23 months ago, found earlier by the assistant] From an email, found Nov 27:');
    expect(block).toContain('[2026-11-12, yesterday, found earlier by the assistant] From an email, found Nov 12:');
  });
});
