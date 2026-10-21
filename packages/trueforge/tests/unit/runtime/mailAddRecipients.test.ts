import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SentinelServices } from '@truefoundry/trueforge-core/core';

import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
import { SqliteApprovalTokenStore } from '../../../src/db/sqlite/approval-token-store/SqliteApprovalTokenStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpToolGrantStore } from '../../../src/db/sqlite/mcp-tool-grant-store/SqliteMcpToolGrantStore';
import { SqliteSentinelSettingsStore } from '../../../src/db/sqlite/sentinel-settings-store/SqliteSentinelSettingsStore';
import {
  allowedRecipientsFileHash,
  ensureAllowedRecipientsFile,
  renderAllowedRecipientsFile,
} from '../../../src/runtime/mailAllowedRecipients';
import { createSentinelServices } from '../../../src/runtime/sentinelServices';

const alice = { tenant_id: 't1', created_by: 'alice' };

describe('the Email send list add', () => {
  let directory: string;
  let policyPath: string;
  let statusPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tfy-mail-add-'));
    policyPath = join(directory, 'allowed_recipients.toml');
    statusPath = join(directory, 'loaded.sha256');
    await ensureAllowedRecipientsFile({ path: policyPath });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function servicesWith(paths: { mailPolicyPath: string | undefined; mailPolicyStatusPath: string | undefined }) {
    const databaseFile = join(directory, 'sentinel.sqlite');
    const migrate = createSqliteDb(databaseFile);
    try {
      await migrateSqliteToLatest(migrate);
    } finally {
      await migrate.destroy();
    }
    const db = createSqliteDb(databaseFile);
    const services: SentinelServices = createSentinelServices({
      demoMode: false,
      demoSendAllowlist: [],
      ...paths,
      audit: new SentinelAuditStore(db),
      settings: new SqliteSentinelSettingsStore(db),
      approvalTokens: new SqliteApprovalTokenStore(db),
      toolGrants: new SqliteMcpToolGrantStore(db),
      outboundSecrets: () => Promise.resolve([]),
    });
    return { services, close: () => db.destroy() };
  }

  it('writes the address and reports loaded once the sidecar records the new list', async () => {
    const { services, close } = await servicesWith({ mailPolicyPath: policyPath, mailPolicyStatusPath: statusPath });
    try {
      const expected = allowedRecipientsFileHash(renderAllowedRecipientsFile(['dana@example.com']));
      setTimeout(() => {
        void writeFile(statusPath, `${expected}\n`);
      }, 30);
      await expect(services.mail_add_recipients(alice, ['dana@example.com'])).resolves.toBe('loaded');
      await expect(services.mail_listed_addresses(alice)).resolves.toEqual(['dana@example.com']);
      expect(await readFile(policyPath, 'utf8')).toBe(renderAllowedRecipientsFile(['dana@example.com']));
    } finally {
      await close();
    }
  });

  it('refuses a wildcard and leaves the list as it was', async () => {
    const { services, close } = await servicesWith({ mailPolicyPath: policyPath, mailPolicyStatusPath: statusPath });
    try {
      await expect(services.mail_add_recipients(alice, ['*@example.com'])).resolves.toBe('refused');
      await expect(services.mail_listed_addresses(alice)).resolves.toEqual([]);
    } finally {
      await close();
    }
  });

  it('reports the list loaded only when the sidecar has recorded the hash of the file as it is now', async () => {
    const { services, close } = await servicesWith({ mailPolicyPath: policyPath, mailPolicyStatusPath: statusPath });
    try {
      await writeFile(statusPath, `${allowedRecipientsFileHash(renderAllowedRecipientsFile([]))}\n`);
      await expect(services.mail_list_loaded(alice)).resolves.toBe('loaded');

      await writeFile(policyPath, renderAllowedRecipientsFile(['dana@example.com']));
      await expect(services.mail_list_loaded(alice)).resolves.toBe('not_loaded');
    } finally {
      await close();
    }
  }, 30_000);

  it('reports not loaded when no send list is configured', async () => {
    const { services, close } = await servicesWith({ mailPolicyPath: undefined, mailPolicyStatusPath: undefined });
    try {
      await expect(services.mail_list_loaded(alice)).resolves.toBe('not_loaded');
    } finally {
      await close();
    }
  });

  it('refuses every add when no send list is configured', async () => {
    const { services, close } = await servicesWith({ mailPolicyPath: undefined, mailPolicyStatusPath: undefined });
    try {
      await expect(services.mail_add_recipients(alice, ['dana@example.com'])).resolves.toBe('refused');
    } finally {
      await close();
    }
  });
});
