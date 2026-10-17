import { OpenAPIHono } from '@hono/zod-openapi';
import winston from 'winston';
import { createAgentImportRouter } from '../../../src/apis/agentImport';
import { createAppErrorHandler } from '../../../src/app';
import { PostgresSessionStore } from '../../../src/db/postgres/session-store/PostgresSessionStore';

describe('agent import router errors', () => {
  it('answers a failed checkpoint read with a generic 500 that echoes nothing from the failure', async () => {
    const planted = 'plantedDbPassword0000';
    // Only the prototype matters here: the router checks for the Postgres store before reading.
    const sessionStore: PostgresSessionStore = Object.create(PostgresSessionStore.prototype);
    sessionStore.getImportSessionsCheckpoint = () =>
      Promise.reject(new Error(`connection to postgres://app:${planted}@db.example.test/app failed`));
    const app = new OpenAPIHono();
    app.route(
      '/',
      createAgentImportRouter({
        sessionStore,
        resolveImportAgentStore: () => {
          throw new Error('not used');
        },
      }),
    );
    app.onError(createAppErrorHandler({ logger: winston.createLogger({ silent: true }) }));

    const response = await app.request('/checkpoint?tenant_id=default');

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain(planted);
    expect(text).not.toContain('agentImport');
    expect(JSON.parse(text)).toEqual({ error: { message: 'Internal server error' } });
  });
});
