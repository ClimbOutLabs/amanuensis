import { execFileRunner } from '@truefoundry/trueforge-core/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { createLogger } from 'winston';

import { namespaceDirFor } from '../../../../src/runtime/memory/markdownMemoryFiles';
import { commitPageChange } from '../../../../src/runtime/memory/memoryPageWriter';
import {
  inQuietHours,
  runNightlyForVault,
  runNightlyJob,
  serverDay,
  type NightlyDeps,
  type NightlyVault,
} from '../../../../src/runtime/memory/nightlyJob';
import type { PageSortMode } from '../../../../src/runtime/memory/pageSortMode';
import { vaultStateDir } from '../../../../src/runtime/memory/vaultLock';
import {
  changeOptions,
  fakeSummarize,
  history,
  IGNORE_ALL,
  makeBase,
  NAMESPACE,
  NIGHT,
  pageWith,
  readPage,
  writeDay,
  writePage,
} from './nightlyTestKit';

const PERSONA_NAMESPACE = 'default__persona_Maya';
const SHARED: NightlyVault = { namespace: NAMESPACE };
const PERSONA: NightlyVault = {
  namespace: PERSONA_NAMESPACE,
  persona: { id: 'p1', name: 'Maya', modelName: 'maya/model' },
};

const ENDED = '- Booked the movie. <!-- fact: id=f_01 src=mail since=2026-10-30 until=2026-11-01 -->';
const TWO_LINES = pageWith({
  now: [ENDED, '- Lives in Madrid. <!-- fact: id=f_02 src=you_said since=2026-01 -->'],
  unconfirmed: ['- Lives in Lisbon. <!-- fact: id=f_03 src=read_content seen=2026-11-01 -->'],
});

function answerByQuestion(prompt: string): unknown {
  return prompt.includes('You sort one saved note')
    ? IGNORE_ALL
    : { pairs: [{ a: 'f_02', b: 'f_03', reason: 'Two different cities.' }] };
}

function setUpDeps({
  baseDir,
  mode = 'on',
  now = NIGHT,
  vaults = [SHARED],
  answer = answerByQuestion,
}: {
  baseDir: string;
  mode?: PageSortMode;
  now?: Date;
  vaults?: NightlyVault[];
  answer?: (prompt: string) => Promise<unknown> | unknown;
}) {
  const logger = createLogger({ silent: true });
  const info = jest.spyOn(logger, 'info');
  const summarizeFor = jest.fn((_vault: NightlyVault) => Promise.resolve(fakeSummarize(answer)));
  const deps: NightlyDeps = {
    baseDir,
    mode,
    hour: 2,
    now: () => now,
    vaults: () => Promise.resolve(vaults),
    summarizeFor,
    similarPagesFor: () => undefined,
    runner: execFileRunner,
    logger,
  };
  return { deps, info, summarizeFor };
}

async function vaultWithPage(baseDir: string, namespace: string) {
  const vaultDir = namespaceDirFor(baseDir, namespace);
  await mkdir(vaultDir, { recursive: true });
  await writePage(vaultDir, 'matter', 'wendy', TWO_LINES);
  return vaultDir;
}

describe('the nightly job', () => {
  it('does all three steps for a vault and logs one line of counts', async () => {
    const { baseDir, vaultDir } = await makeBase();
    await writePage(vaultDir, 'matter', 'wendy', TWO_LINES);
    await writeDay({ vaultDir, day: '2026-11-09', notes: ['A secret note about Wendy.'] });
    const { deps, info } = setUpDeps({ baseDir });

    const outcome = await runNightlyForVault({ vault: SHARED, deps });

    expect(outcome).toEqual({
      status: 'ran',
      counts: {
        movedToEarlier: 1,
        notesAsked: 1,
        notesSorted: 1,
        pagesAsked: 1,
        pairsListed: 1,
        vaultsWithoutModel: 0,
      },
    });
    expect(history(vaultDir)).toContain('Aman moved 1 ended line to Earlier');
    expect(await readPage(vaultDir, 'matter', 'wendy')).toContain('## Earlier\n- Booked the movie.');
    const summary = info.mock.calls.filter(([message]) => String(message).startsWith('Nightly memory tidy'));
    expect(summary).toHaveLength(1);
    expect(JSON.stringify(summary)).not.toMatch(/secret|Madrid|Lisbon|movie/);
  });

  it('moves ended lines in every mode but asks no model with sorting off', async () => {
    const { baseDir, vaultDir } = await makeBase();
    await writePage(vaultDir, 'matter', 'wendy', TWO_LINES);
    const { deps, summarizeFor } = setUpDeps({ baseDir, mode: 'off' });

    await runNightlyForVault({ vault: SHARED, deps });

    expect(history(vaultDir)).toContain('Aman moved 1 ended line to Earlier');
    expect(summarizeFor).not.toHaveBeenCalled();
  });

  it('skips the model steps when no model is configured, and still moves ended lines', async () => {
    const { baseDir, vaultDir } = await makeBase();
    await writePage(vaultDir, 'matter', 'wendy', TWO_LINES);
    const { deps } = setUpDeps({ baseDir });
    deps.summarizeFor = () => Promise.resolve(undefined);

    const outcome = await runNightlyForVault({ vault: SHARED, deps });

    expect(outcome).toMatchObject({
      status: 'ran',
      counts: { movedToEarlier: 1, notesAsked: 0, pagesAsked: 0, vaultsWithoutModel: 1 },
    });
  });

  it('does not count a vault as missing a model when sorting is off', async () => {
    const { baseDir, vaultDir } = await makeBase();
    await writePage(vaultDir, 'matter', 'wendy', TWO_LINES);
    const { deps } = setUpDeps({ baseDir, mode: 'off' });

    const outcome = await runNightlyForVault({ vault: SHARED, deps });

    expect(outcome).toMatchObject({ status: 'ran', counts: { vaultsWithoutModel: 0 } });
  });

  it('runs once a day per vault, and again the next day', async () => {
    const { baseDir, vaultDir } = await makeBase();
    await writePage(vaultDir, 'matter', 'wendy', TWO_LINES);
    const { deps } = setUpDeps({ baseDir });

    expect((await runNightlyForVault({ vault: SHARED, deps })).status).toBe('ran');
    expect(await runNightlyForVault({ vault: SHARED, deps })).toEqual({ status: 'skipped', reason: 'already_ran' });

    deps.now = () => new Date(2026, 10, 12, 3, 0, 0);
    expect((await runNightlyForVault({ vault: SHARED, deps })).status).toBe('ran');
  });

  it('runs once when two runners start at the same moment', async () => {
    const { baseDir, vaultDir } = await makeBase();
    await writePage(vaultDir, 'matter', 'wendy', TWO_LINES);
    const first = setUpDeps({ baseDir });
    const second = setUpDeps({ baseDir });

    const outcomes = await Promise.all([
      runNightlyForVault({ vault: SHARED, deps: first.deps }),
      runNightlyForVault({ vault: SHARED, deps: second.deps }),
    ]);

    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['ran', 'skipped']);
    expect(history(vaultDir).filter(entry => entry.startsWith('Aman moved'))).toHaveLength(1);
  });

  it('does a persona’s vault separately from the shared one', async () => {
    const { baseDir } = await makeBase();
    const sharedDir = await vaultWithPage(baseDir, NAMESPACE);
    const personaDir = await vaultWithPage(baseDir, PERSONA_NAMESPACE);
    const { deps, summarizeFor } = setUpDeps({ baseDir, vaults: [SHARED, PERSONA] });

    await runNightlyJob({ deps });

    expect(history(sharedDir)).toContain('Aman moved 1 ended line to Earlier');
    expect(history(personaDir)).toContain('Aman moved 1 ended line to Earlier');
    expect(summarizeFor.mock.calls.map(([vault]) => vault.persona?.modelName)).toEqual([undefined, 'maya/model']);
    expect(await runNightlyForVault({ vault: PERSONA, deps })).toMatchObject({ reason: 'already_ran' });
  });

  it('logs a failure in one vault and goes on to the next', async () => {
    const { baseDir } = await makeBase();
    const brokenDir = namespaceDirFor(baseDir, 'default__broken');
    await mkdir(brokenDir, { recursive: true });
    await writeFile(vaultStateDir(brokenDir), 'not a folder');
    const goodDir = await vaultWithPage(baseDir, PERSONA_NAMESPACE);
    const { deps } = setUpDeps({ baseDir, vaults: [{ namespace: 'default__broken' }, PERSONA] });
    const warn = jest.spyOn(deps.logger, 'warn');

    await runNightlyJob({ deps });

    expect(warn).toHaveBeenCalledWith('The nightly memory tidy failed for a vault.', expect.anything());
    expect(history(goodDir)).toContain('Aman moved 1 ended line to Earlier');
  });

  it('runs at any hour when the person asks, and does not take the day', async () => {
    const { baseDir, vaultDir } = await makeBase();
    await writePage(vaultDir, 'matter', 'wendy', TWO_LINES);
    const noon = new Date(2026, 10, 11, 12, 0, 0);
    const { deps } = setUpDeps({ baseDir, now: noon });

    const counts = await runNightlyJob({ deps, onRequest: true });

    expect(counts.movedToEarlier).toBe(1);
    expect(history(vaultDir)).toContain('Aman moved 1 ended line to Earlier');
    expect((await runNightlyForVault({ vault: SHARED, deps })).status).toBe('ran');
  });

  it('does nothing outside the quiet hours, and skips a vault that has no folder yet', async () => {
    const { baseDir, vaultDir } = await makeBase();
    await writePage(vaultDir, 'matter', 'wendy', TWO_LINES);
    const noon = new Date(2026, 10, 11, 12, 0, 0);
    const { deps } = setUpDeps({ baseDir, now: noon });

    await runNightlyJob({ deps });

    expect(history(vaultDir)).toEqual([]);
    expect(inQuietHours({ now: noon, hour: 2 })).toBe(false);
    expect(inQuietHours({ now: NIGHT, hour: 2 })).toBe(true);
    expect(inQuietHours({ now: noon, hour: 12 })).toBe(true);
    expect(inQuietHours({ now: new Date(2026, 10, 11, 0, 30, 0), hour: 23 })).toBe(false);
    expect(serverDay(NIGHT)).toBe('2026-11-11');
    expect(await runNightlyForVault({ vault: { namespace: 'default__nobody' }, deps })).toEqual({
      status: 'skipped',
      reason: 'no_vault',
    });
  });

  it('does not hold up a page edit that happens while the model is thinking', async () => {
    const { baseDir, vaultDir } = await makeBase();
    await writePage(vaultDir, 'matter', 'wendy', TWO_LINES);
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let asking: () => void = () => undefined;
    const asked = new Promise<void>(resolve => {
      asking = resolve;
    });
    const { deps } = setUpDeps({
      baseDir,
      answer: async prompt => {
        asking();
        await gate;
        return answerByQuestion(prompt);
      },
    });

    const running = runNightlyForVault({ vault: SHARED, deps });
    await asked;
    await commitPageChange({
      options: { ...changeOptions(vaultDir), today: '2026-11-11' },
      message: 'You: edited the page',
      change: async () => {
        await writePage(
          vaultDir,
          'matter',
          'wendy',
          (await readPage(vaultDir, 'matter', 'wendy')).replace('Madrid', 'Porto'),
        );
      },
    });
    release();
    await running;

    expect(history(vaultDir)).toContain('You: edited the page');
  });
});
