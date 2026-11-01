/**
 * Runs the real data export over a seeded test instance. Import tests build
 * their archives here, so a change to the export's inputs is absorbed in one
 * place.
 */
import { Writable } from 'node:stream';

import { runDataExport, type DataExportDeps } from '../../src/dataExport/exportService';
import type { DataTransferSeedStores } from './dataTransferSeed';

export class CollectingWritable extends Writable {
  private readonly chunks: Buffer[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export interface ExportableInstance<TTransaction> {
  stores: DataTransferSeedStores<TTransaction>;
  memoryDir: string;
  knowledgeDir: string;
}

export const EXPORT_TEST_TIME = new Date('2026-10-16T12:00:00.000Z');

export async function exportInstanceArchive<TTransaction>({
  instance,
  tenantId,
  subjectId,
  includeUploads = true,
  secrets = [],
  maxEntryBytes,
}: {
  instance: ExportableInstance<TTransaction>;
  tenantId: string;
  subjectId: string;
  includeUploads?: boolean;
  /** Normalized exact-match secrets, as the entry points pass them. */
  secrets?: readonly string[];
  /** A small per-file cap, so a test can pass it without a huge archive. */
  maxEntryBytes?: number;
}): Promise<Buffer> {
  const { stores } = instance;
  const deps: DataExportDeps<TTransaction> = {
    sessionStore: stores.sessionStore,
    personaStore: stores.personaStore,
    personalizationStore: stores.personalizationStore,
    spaceStore: stores.spaceStore,
    scheduleStore: stores.scheduleStore,
    globalSettingsStore: stores.globalSettingsStore,
    sentinelSettingsStore: stores.sentinelSettingsStore,
    auditStore: stores.auditStore,
    deliveryStore: stores.deliveryStore,
    turnArtifactStore: stores.turnArtifactStore,
    mcpServerStore: stores.mcpServerStore,
    listAgents: async () =>
      (
        await stores.agentStore.listAgents({
          include_host_managed: true,
          tenant_id: tenantId,
          agent_name: undefined,
          limit: undefined,
          page_token: undefined,
        })
      ).data.filter(agent => agent.created_by_subject.subject_id === subjectId),
    memorySource: { kind: 'markdown', markdownDir: instance.memoryDir },
    personaKnowledgeDir: instance.knowledgeDir,
  };
  const sink = new CollectingWritable();
  await runDataExport(
    deps,
    {
      subject: { tenantId, subjectId, includeUploads, includeInstanceData: true },
      secrets,
      exportedAt: EXPORT_TEST_TIME,
      appVersion: '0.0.0-test',
      maxBytes: 1024 * 1024 * 1024,
      ...(maxEntryBytes === undefined ? {} : { maxEntryBytes }),
    },
    sink,
  );
  return sink.buffer();
}
