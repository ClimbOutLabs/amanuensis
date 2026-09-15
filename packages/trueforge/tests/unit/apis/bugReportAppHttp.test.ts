// The app-level bug-report bundle sources sandbox capability from the PERSISTED status only
// (read-only, no egress), same as the session bundle. Stub the provider checks so tests never
// touch Daytona.
jest.mock('../../../src/sandbox/providerUtils', () => ({
  checkSnapshotStatus: jest.fn(),
  readPersistedSnapshotStatus: jest.fn(),
}));

import { OpenAPIHono } from '@hono/zod-openapi';
import { createLogger } from 'winston';
import { createAppBugReportRouter } from '../../../src/apis/bugReportApp';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { readPersistedSnapshotStatus } from '../../../src/sandbox/providerUtils';

const mockPersistedStatus: jest.Mock = jest.mocked(readPersistedSnapshotStatus);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function responseData(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json();
  if (!isRecord(body) || !isRecord(body['data'])) {
    throw new Error('expected a { data: {...} } JSON body');
  }
  return body['data'];
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('app-level bug-report HTTP endpoints', () => {
  let app: OpenAPIHono;

  beforeEach(async () => {
    mockPersistedStatus.mockReset();
    mockPersistedStatus.mockResolvedValue(undefined);

    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const mcpServerStore = new SqliteMcpServerStore(db);
    const sandboxProviderStore = new SqliteSandboxProviderStore(db);

    app = new OpenAPIHono();
    // Mounted at the same subpath as in src/app.ts, so the route registrations are
    // exercised at their real paths.
    app.route(
      '/bug-reports',
      createAppBugReportRouter({
        sandboxProviderStore,
        mcpServerStore,
        resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
        logger: createLogger({ silent: true }),
      }),
    );
  });

  it('POST /bug-reports returns a redacted app bundle with no session data', async () => {
    const res = await app.request('/bug-reports', jsonInit('POST', { description: 'It broke' }));
    expect(res.status).toBe(200);
    const data = await responseData(res);

    expect(data['schema_version']).toBe(1);
    expect(data['user_description']).toBe('It broke');
    expect(data['build']).toEqual(expect.objectContaining({ version: expect.any(String) }));
    expect(data['config_flags']).toEqual({
      sandbox_enabled: expect.any(Boolean),
      skill_enabled: expect.any(Boolean),
      settings_enabled: expect.any(Boolean),
    });
    expect(data['redaction']).toEqual(
      expect.objectContaining({
        stripped_fields: expect.arrayContaining([expect.stringContaining('session'), expect.stringContaining('chat')]),
        notes: expect.any(String),
      }),
    );
    // Session-less by design: these keys must never appear on the wire.
    expect(data).not.toHaveProperty('session');
    expect(data).not.toHaveProperty('trace');
    expect(data).not.toHaveProperty('chat');
  });

  it('POST /bug-reports carries an empty description when none is supplied', async () => {
    const res = await app.request('/bug-reports', jsonInit('POST', {}));
    expect(res.status).toBe(200);
    const data = await responseData(res);
    expect(data['user_description']).toBe('');
  });

  it('POST /bug-reports rejects an over-long description', async () => {
    const res = await app.request('/bug-reports', jsonInit('POST', { description: 'x'.repeat(8001) }));
    expect(res.status).toBe(400);
  });

  it('GET /bug-reports/handoff returns the host-configured handoff URL (null when unset)', async () => {
    const res = await app.request('/bug-reports/handoff', { method: 'GET' });
    expect(res.status).toBe(200);
    const data = await responseData(res);
    // The route is a pure lookup of the config-owned env var: the single owner is config.ts.
    expect(data['issue_url']).toBe(configuration.BUG_REPORT_HANDOFF_URL);
  });
});
