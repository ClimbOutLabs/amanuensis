import { SandboxFileTooLargeError, SandboxNotAvailableError } from '@truefoundry/trueforge-core/core';
import winston from 'winston';
import {
  PERSISTED_ARTIFACT_MIME,
  submitArtifactPersistence,
} from '../../../../src/runtime/artifacts/persistTurnArtifacts';
import { FakeSandboxProvider } from '../../../fixtures/fakeSandboxProvider';
import { FakeTurnArtifactStore } from '../../../fixtures/fakeTurnArtifactStore';

const IDENTITY = { tenantId: 'default', sessionId: 's1', turnId: 't1', sandboxId: 'sbx-1' };
const logger = winston.createLogger({ silent: true });

function assistantMessage(fenceBody: string): string {
  return ['Here you go:', '', '```sandbox_artifacts', fenceBody, '```'].join('\n');
}

describe('submitArtifactPersistence', () => {
  it('is a no-op when the turn declared no sandbox_artifacts block', async () => {
    const store = new FakeTurnArtifactStore();
    const provider = new FakeSandboxProvider(new Map());

    await submitArtifactPersistence({
      store,
      provider,
      ...IDENTITY,
      assistantText: 'Just a plain reply, nothing to download.',
      logger,
    });

    expect(store.records.size).toBe(0);
  });

  it('downloads and stores a declared file, content-addressed by digest', async () => {
    const data = Buffer.from('the finished tribute video');
    const store = new FakeTurnArtifactStore();
    const provider = new FakeSandboxProvider(new Map([['/opt/tf/workspace/tribute.mp4', data]]));

    await submitArtifactPersistence({
      store,
      provider,
      ...IDENTITY,
      assistantText: assistantMessage('[Lily James tribute video](/opt/tf/workspace/tribute.mp4)'),
      logger,
    });

    const record = await store.getArtifact({
      tenant_id: IDENTITY.tenantId,
      session_id: IDENTITY.sessionId,
      turn_id: IDENTITY.turnId,
      path: '/opt/tf/workspace/tribute.mp4',
    });
    expect(record?.status).toBe('stored');
    expect(record?.name).toBe('Lily James tribute video');
    expect(record?.mime).toBe(PERSISTED_ARTIFACT_MIME);
    expect(record?.digest).toMatch(/^[0-9a-f]{64}$/);
    const blob = await store.getBlob({ tenant_id: IDENTITY.tenantId, digest: record?.digest ?? '' });
    expect(blob).toEqual(data);
  });

  it('persists every file in a multi-file declaration', async () => {
    const store = new FakeTurnArtifactStore();
    const provider = new FakeSandboxProvider(
      new Map([
        ['/tmp/a.txt', Buffer.from('a')],
        ['/tmp/b.txt', Buffer.from('b')],
      ]),
    );

    await submitArtifactPersistence({
      store,
      provider,
      ...IDENTITY,
      assistantText: assistantMessage('[a.txt](/tmp/a.txt)\n[b.txt](/tmp/b.txt)'),
      logger,
    });

    expect(
      (
        await store.getArtifact({
          tenant_id: IDENTITY.tenantId,
          session_id: IDENTITY.sessionId,
          turn_id: IDENTITY.turnId,
          path: '/tmp/a.txt',
        })
      )?.status,
    ).toBe('stored');
    expect(
      (
        await store.getArtifact({
          tenant_id: IDENTITY.tenantId,
          session_id: IDENTITY.sessionId,
          turn_id: IDENTITY.turnId,
          path: '/tmp/b.txt',
        })
      )?.status,
    ).toBe('stored');
  });

  it('records skipped_size (no blob) for a file over the download cap, and keeps going', async () => {
    const store = new FakeTurnArtifactStore();
    const provider = new FakeSandboxProvider(
      new Map<string, Buffer | Error>([
        ['/tmp/huge.bin', new SandboxFileTooLargeError('/tmp/huge.bin', 30_000_000, 26_214_400)],
        ['/tmp/small.txt', Buffer.from('fits fine')],
      ]),
    );

    await submitArtifactPersistence({
      store,
      provider,
      ...IDENTITY,
      assistantText: assistantMessage('[huge.bin](/tmp/huge.bin)\n[small.txt](/tmp/small.txt)'),
      logger,
    });

    const huge = await store.getArtifact({
      tenant_id: IDENTITY.tenantId,
      session_id: IDENTITY.sessionId,
      turn_id: IDENTITY.turnId,
      path: '/tmp/huge.bin',
    });
    expect(huge?.status).toBe('skipped_size');
    expect(huge?.digest).toBeNull();
    expect(huge?.size).toBe(30_000_000);
    expect(huge?.skip_reason).toContain('too large');

    const small = await store.getArtifact({
      tenant_id: IDENTITY.tenantId,
      session_id: IDENTITY.sessionId,
      turn_id: IDENTITY.turnId,
      path: '/tmp/small.txt',
    });
    expect(small?.status).toBe('stored');
  });

  it('records skipped_missing for a declared path the sandbox no longer has', async () => {
    const store = new FakeTurnArtifactStore();
    const provider = new FakeSandboxProvider(new Map());

    await submitArtifactPersistence({
      store,
      provider,
      ...IDENTITY,
      assistantText: assistantMessage('[gone.txt](/tmp/gone.txt)'),
      logger,
    });

    const record = await store.getArtifact({
      tenant_id: IDENTITY.tenantId,
      session_id: IDENTITY.sessionId,
      turn_id: IDENTITY.turnId,
      path: '/tmp/gone.txt',
    });
    expect(record?.status).toBe('skipped_missing');
    expect(record?.digest).toBeNull();
  });

  it('stops the batch (without recording a row) once the sandbox itself is gone', async () => {
    const store = new FakeTurnArtifactStore();
    const provider = new FakeSandboxProvider(
      new Map<string, Buffer | Error>([
        ['/tmp/a.txt', new SandboxNotAvailableError(IDENTITY.sandboxId)],
        ['/tmp/b.txt', Buffer.from('would have worked')],
      ]),
    );

    await submitArtifactPersistence({
      store,
      provider,
      ...IDENTITY,
      assistantText: assistantMessage('[a.txt](/tmp/a.txt)\n[b.txt](/tmp/b.txt)'),
      logger,
    });

    expect(store.records.size).toBe(0);
  });

  it('never throws, even when the store itself fails', async () => {
    const store = new FakeTurnArtifactStore();
    jest.spyOn(store, 'recordStoredArtifact').mockRejectedValue(new Error('db is down'));
    const provider = new FakeSandboxProvider(new Map([['/tmp/a.txt', Buffer.from('a')]]));

    await expect(
      submitArtifactPersistence({
        store,
        provider,
        ...IDENTITY,
        assistantText: assistantMessage('[a.txt](/tmp/a.txt)'),
        logger,
      }),
    ).resolves.toBeUndefined();
  });
});
