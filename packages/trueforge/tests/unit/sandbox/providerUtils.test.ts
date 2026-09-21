import { DaytonaSandboxProvider, type SandboxBuild } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';
import type { ISandboxProviderStore, SandboxProviderRecord } from '../../../src/db/sandboxProviderStore';
import { checkSnapshotStatus } from '../../../src/sandbox/providerUtils';

const oldMetadata = { build_ref: 'trueforge-build-old', image_uri: 'registry.test/sandbox:old' };
const newMetadata = { build_ref: 'trueforge-build-new', image_uri: 'registry.test/sandbox:new' };

const oldRecord: SandboxProviderRecord = {
  tenant_id: 'default',
  manifest: {
    type: 'daytona',
    api_url: 'https://daytona.test/api',
    auth: { api_key: 'dtn-test' },
    exec_timeout_ms: 60_000,
    auto_stop_interval_in_minutes: 5,
    auto_archive_interval_in_minutes: 60,
    auto_delete_interval_in_minutes: 7_200,
  },
  status: 'pending',
  status_reason: 'old image pending',
  build_metadata: oldMetadata,
  created_at: '2026-09-03T00:00:00.000Z',
  updated_at: '2026-09-03T00:00:00.000Z',
};

const newRecord: SandboxProviderRecord = {
  ...oldRecord,
  status: 'ready',
  status_reason: null,
  build_metadata: newMetadata,
  updated_at: '2026-09-03T00:00:01.000Z',
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('checkSnapshotStatus', () => {
  it('discards a stale remote result when a newer provider write wins', async () => {
    const remoteBuild: SandboxBuild = {
      status: 'ready',
      reason: null,
      metadata: oldMetadata,
    };
    jest.spyOn(DaytonaSandboxProvider.prototype, 'getImageBuildStatus').mockResolvedValue(remoteBuild);

    const getSandboxProvider = jest
      .fn<Promise<SandboxProviderRecord | undefined>, [string]>()
      .mockResolvedValueOnce(oldRecord)
      .mockResolvedValueOnce(newRecord);
    const updateSandboxStatus = jest.fn().mockResolvedValue(undefined);
    const store: ISandboxProviderStore = {
      getSandboxProvider,
      getSandboxProviderForUpdate: async () => undefined,
      upsertSandboxProvider: async () => {
        throw new Error('not used');
      },
      updateSandboxStatus,
    };

    const status = await checkSnapshotStatus({
      store,
      tenant_id: 'default',
      logger: createLogger({ silent: true }),
    });

    expect(updateSandboxStatus).toHaveBeenCalledWith({
      tenant_id: 'default',
      expected_manifest: oldRecord.manifest,
      expected_build_metadata: oldMetadata,
      status: 'ready',
      status_reason: null,
      build_metadata: oldMetadata,
    });
    expect(status).toEqual({ status: 'ready', status_reason: null, build_metadata: newMetadata });
  });
});
