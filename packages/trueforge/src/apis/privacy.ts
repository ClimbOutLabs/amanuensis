/**
 * Privacy product surface (mounted at /api/v1/privacy): one-click data
 * export, the machine-readable data-flow manifest, and the offline-mode
 * toggle. Admin-gated at the mount boundary in app.ts, like /api/v1/settings.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type {
  ISessionStore,
  SessionRecord,
  TokenPagination,
  TurnRecordWithoutSnapshot,
} from '@truefoundry/trueforge-core/agent-session';
import type { Context } from 'hono';
import type { Logger } from 'winston';

import type { ResolveRequestContext } from '../auth/identity';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IPersonaStore, Persona } from '../db/personaStore';
import type { IScheduleStore, ScheduleRecord } from '../db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { getDataFlowManifest } from '../privacy/dataFlow';
import { scrubSecrets } from '../privacy/exportScrub';
import { namespaceDirFor, sanitizeNamespace } from '../runtime/memory/markdownMemoryFiles';
import {
  PRIVACY_OFFLINE_MODE_SETTING_KEY,
  isOfflineModeEnabled,
  setOfflineModeEnabled,
} from '../privacy/offlineGuard';
import { createZip, type ZipEntry } from '../privacy/zipWriter';
import {
  getDataFlowManifestRoute,
  getOfflineModeRoute,
  getPrivacyExportRoute,
  putOfflineModeRoute,
} from '../routes/privacyRoutes';
import { MEMORY_SCREEN_ENABLED_SETTING_KEY } from '../runtime/memoryScreenSettings';
import { MEMORY_SUMMARIZE_SETTING_KEY } from '../runtime/memorySummarizeSettings';
import { TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY } from '../runtime/toolOutputScreenSettings';

export interface PrivacyRouterDeps<TTransaction> {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  personaStore: IPersonaStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
  /** Resolved `MEMORY_MARKDOWN_DIR`: where namespace memory files live on disk. */
  memoryMarkdownDir: string;
}

/** Global settings exported as the caller's `settings.json`. */
const EXPORTED_SETTING_KEYS = [
  MEMORY_SCREEN_ENABLED_SETTING_KEY,
  MEMORY_SUMMARIZE_SETTING_KEY,
  TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY,
  PRIVACY_OFFLINE_MODE_SETTING_KEY,
];

const EXPORT_PAGE_LIMIT = 200;

/** Copies a Uint8Array into a detached ArrayBuffer for `c.body`. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(view.byteLength);
  new Uint8Array(buffer).set(view);
  return buffer;
}

/** One chat in the export: the session plus its turns. */
export interface ExportChat {
  session: SessionRecord<SessionCustom>;
  turns: TurnRecordWithoutSnapshot<TurnCustom>[];
}

/** Everything `buildExportZip` packs into the download. */
export interface PrivacyExportData {
  exported_at: string;
  chats: ExportChat[];
  personas: Persona[];
  schedules: ScheduleRecord[];
  settings: Record<string, string>;
  memory_files: ZipEntry[];
}

async function listAllPages<TItem>(options: {
  list: (pageToken: string | undefined) => Promise<{ data: TItem[]; pagination: TokenPagination }>;
}): Promise<TItem[]> {
  const items: TItem[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const page = await options.list(pageToken);
    items.push(...page.data);
    const next = page.pagination.next_page_token;
    if (next === undefined || next === pageToken) {
      break;
    }
    pageToken = next;
  }
  return items;
}

/** Reads one tenant namespace's memory files; missing files are normal, not failures. */
async function readNamespaceMemoryFiles(options: {
  baseDir: string;
  namespace: string;
}): Promise<ZipEntry[]> {
  const { baseDir, namespace } = options;
  const safeNamespace = sanitizeNamespace(namespace);
  const dir = namespaceDirFor(baseDir, namespace);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) {
    return [];
  }
  const entries: ZipEntry[] = [];
  const readIfExists = async (filePath: string): Promise<Uint8Array | undefined> => {
    try {
      return await fs.readFile(filePath);
    } catch {
      return undefined;
    }
  };
  const memoryMd = await readIfExists(path.join(dir, 'MEMORY.md'));
  if (memoryMd !== undefined) {
    entries.push({ name: `memory/${safeNamespace}/MEMORY.md`, data: memoryMd });
  }
  let dailyFiles: string[] = [];
  try {
    dailyFiles = (await fs.readdir(path.join(dir, 'memory'))).filter(name => name.endsWith('.md'));
  } catch {
    dailyFiles = [];
  }
  for (const file of dailyFiles.sort()) {
    const content = await readIfExists(path.join(dir, 'memory', file));
    if (content !== undefined) {
      entries.push({ name: `memory/${safeNamespace}/memory/${file}`, data: content });
    }
  }
  return entries;
}

function toJsonEntry(name: string, value: unknown): ZipEntry {
  // Credential-shaped values are redacted; memory files ship verbatim (see docs).
  const scrubbed = scrubSecrets(value);
  return { name, data: new TextEncoder().encode(JSON.stringify(scrubbed, null, 2)) };
}

/** Assembles the export zip entries from already-collected data. Pure and unit-tested. */
export function buildExportZip(data: PrivacyExportData): Uint8Array {
  const entries: ZipEntry[] = [
    toJsonEntry('chats.json', data.chats),
    toJsonEntry('personas.json', data.personas),
    toJsonEntry('schedules.json', data.schedules),
    toJsonEntry('settings.json', data.settings),
    toJsonEntry(
      'manifest.json',
      {
        exported_at: data.exported_at,
        format_version: 1,
        counts: {
          chats: data.chats.length,
          personas: data.personas.length,
          schedules: data.schedules.length,
          memory_files: data.memory_files.length,
        },
      },
    ),
    ...data.memory_files,
  ];
  return createZip(entries);
}

export function createPrivacyRouter<TTransaction>(deps: PrivacyRouterDeps<TTransaction>) {
  const exportHandler: RouteHandler<typeof getPrivacyExportRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const tenantId = requestContext.tenant_id;
    const subjectId = requestContext.subject.id;

    const chats: ExportChat[] = [];
    const sessions = await listAllPages({
      list: pageToken =>
        deps.sessionStore.listSessions({
          tenant_id: tenantId,
          limit: EXPORT_PAGE_LIMIT,
          page_token: pageToken,
          order: 'asc',
          start_timestamp: undefined,
          end_timestamp: undefined,
          agent_id: undefined,
          created_by_or_agent_ids: { created_by_subject_id: subjectId, agent_ids: [] },
          metadata: undefined,
          source_type: undefined,
          source_id: undefined,
        }),
    });
    for (const session of sessions) {
      const turns = await listAllPages({
        list: pageToken =>
          deps.sessionStore.listTurns({
            session_id: session.session_id,
            limit: EXPORT_PAGE_LIMIT,
            page_token: pageToken,
          }),
      });
      chats.push({ session, turns });
    }

    const personas = await deps.personaStore.listPersonas({ tenant_id: tenantId, created_by: subjectId });
    const schedules = await listAllPages({
      list: pageToken =>
        deps.scheduleStore.listSchedules({
          tenant_id: tenantId,
          limit: EXPORT_PAGE_LIMIT,
          page_token: pageToken,
          agent_names: undefined,
          created_by_or_agent_ids: { created_by_subject_id: subjectId, agent_ids: [] },
        }),
    });

    const settings: Record<string, string> = {};
    for (const key of EXPORTED_SETTING_KEYS) {
      const record = await deps.globalSettingsStore.getSetting({ key });
      if (record !== undefined) {
        settings[key] = record.value;
      }
    }

    // Memory is namespaced per tenant: the export carries only the caller's
    // tenant namespace, never another tenant's files.
    const memoryFiles = await readNamespaceMemoryFiles({
      baseDir: deps.memoryMarkdownDir,
      namespace: tenantId,
    });

    const zip = buildExportZip({
      exported_at: new Date().toISOString(),
      chats,
      personas,
      schedules,
      settings,
      memory_files: memoryFiles,
    });

    const dateStamp = new Date().toISOString().slice(0, 10);
    return c.body(toArrayBuffer(zip), 200, {
      'Content-Type': 'application/zip',
      'Content-Length': String(zip.byteLength),
      'Content-Disposition': `attachment; filename="amanuensis-export-${dateStamp}.zip"`,
      'Cache-Control': 'private, no-store',
    });
  };

  const dataFlowHandler: RouteHandler<typeof getDataFlowManifestRoute> = c => {
    return c.json({ data: getDataFlowManifest() }, 200);
  };

  const getOfflineModeHandler: RouteHandler<typeof getOfflineModeRoute> = c => {
    return c.json({ data: { enabled: isOfflineModeEnabled() } }, 200);
  };

  const putOfflineModeHandler: RouteHandler<typeof putOfflineModeRoute> = async c => {
    const body = c.req.valid('json');
    await deps.globalSettingsStore.setSetting({
      key: PRIVACY_OFFLINE_MODE_SETTING_KEY,
      value: body.enabled ? 'true' : 'false',
    });
    // The write committed, so the in-memory flag flips to exactly what was stored.
    setOfflineModeEnabled(body.enabled);
    deps.logger.info('privacy offline mode toggled', { enabled: body.enabled });
    return c.json({ data: { enabled: body.enabled } }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(getPrivacyExportRoute, exportHandler);
  router.openapi(getDataFlowManifestRoute, dataFlowHandler);
  router.openapi(getOfflineModeRoute, getOfflineModeHandler);
  router.openapi(putOfflineModeRoute, putOfflineModeHandler);
  return router;
}
