import { createLogger } from 'winston';

import {
  RUN_CODE_ARTIFACT_PATH_PREFIX,
  buildRunCodeHarvestSink,
  runCodeArtifactPathFor,
} from '../../../../src/runtime/artifacts/persistRunCodeHarvests';
import { FakeTurnArtifactStore } from '../../../fixtures/fakeTurnArtifactStore';

const logger = createLogger({ silent: true });

function makeSink(store: FakeTurnArtifactStore) {
  return buildRunCodeHarvestSink({
    store,
    tenantId: 'default',
    sessionId: 's1',
    turnId: 't1',
    logger,
  });
}

describe('buildRunCodeHarvestSink', () => {
  it('stores every harvested file under run_code/<name> with exact bytes', async () => {
    const store = new FakeTurnArtifactStore();
    const sink = makeSink(store);
    const plot = Buffer.from('fake png bytes');
    const csv = Buffer.from('a,b\n1,2\n');

    await sink([
      { name: 'plot.png', bytes: plot, size_bytes: plot.length, sha256: 'x' },
      { name: 'data.csv', bytes: csv, size_bytes: csv.length, sha256: 'y' },
    ]);

    for (const [name, bytes] of [
      ['plot.png', plot],
      ['data.csv', csv],
    ] as const) {
      const row = await store.getArtifact({
        tenant_id: 'default',
        session_id: 's1',
        turn_id: 't1',
        path: `${RUN_CODE_ARTIFACT_PATH_PREFIX}${name}`,
      });
      expect(row?.status).toBe('stored');
      expect(row?.name).toBe(name);
      expect(row?.size).toBe(bytes.length);
      expect(await store.getBlob({ tenant_id: 'default', digest: row?.digest ?? '' })).toEqual(bytes);
    }
  });

  it('persists the other files when one write fails, then throws naming the failure', async () => {
    const store = new FakeTurnArtifactStore();
    const sink = makeSink(store);
    jest.spyOn(store, 'recordStoredArtifact').mockImplementationOnce(() => Promise.reject(new Error('db on fire')));
    const good = Buffer.from('survivor');

    await expect(
      sink([
        { name: 'bad.png', bytes: Buffer.from('doomed'), size_bytes: 6, sha256: 'x' },
        { name: 'good.txt', bytes: good, size_bytes: good.length, sha256: 'y' },
      ]),
    ).rejects.toThrow(/bad\.png/);

    // Best effort: the good file was still stored despite the aggregate throw.
    const row = await store.getArtifact({
      tenant_id: 'default',
      session_id: 's1',
      turn_id: 't1',
      path: `${RUN_CODE_ARTIFACT_PATH_PREFIX}good.txt`,
    });
    expect(row?.status).toBe('stored');
    expect(await store.getBlob({ tenant_id: 'default', digest: row?.digest ?? '' })).toEqual(good);
  });

  it('resolves without writing when the harvest produced no files', async () => {
    const store = new FakeTurnArtifactStore();
    const sink = makeSink(store);

    await sink([]);

    expect(store.records.size).toBe(0);
    expect(store.blobs.size).toBe(0);
  });
});

describe('runCodeArtifactPathFor', () => {
  it('maps a file named by its run folder to its stored run_code path', () => {
    expect(runCodeArtifactPathFor('/egress/chart.pdf')).toBe('run_code/chart.pdf');
    expect(runCodeArtifactPathFor('/scratch/chart.pdf')).toBe('run_code/chart.pdf');
    expect(runCodeArtifactPathFor('egress/chart.pdf')).toBe('run_code/chart.pdf');
  });

  it('leaves every other path alone, including nested files run_code never keeps', () => {
    expect(runCodeArtifactPathFor('/workspace/chart.pdf')).toBeUndefined();
    expect(runCodeArtifactPathFor('/egress/out/chart.pdf')).toBeUndefined();
    expect(runCodeArtifactPathFor('run_code/chart.pdf')).toBeUndefined();
  });
});
