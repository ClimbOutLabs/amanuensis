/**
 * The Calendar connector over the real route, from a record an import or a Settings edit left without its
 * first-party mark. The host's own sidecar address still earns the trust, and changes still ask.
 */
import { AgentSpecSchema, TurnResourceResolver } from '@truefoundry/trueforge-core/agent-session';
import type { IToolSet } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { createLogger } from 'winston';
import configuration from '../../../src/config';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { getMcpConnection, withGatewayMetadataHeaders } from '../../../src/runtime/sessionResources';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { startInertMcpServer, type InertMcpServer } from '../../fixtures/inertMcpServer';

const TENANT = 'default';
const OWNER = 'owner-1';

describe('the Calendar connector on the real tool route', () => {
  let server: ApprovalTestServer;
  let sidecar: InertMcpServer;
  const originalCalendarUrl = configuration.CALENDAR_CONNECTOR_URL;

  beforeAll(async () => {
    server = await startApprovalTestServer();
    sidecar = await startInertMcpServer({ calendar: true });
    server.setFirstPartyOrigins([sidecar.origin]);
    configuration.CALENDAR_CONNECTOR_URL = sidecar.url;
  }, 120_000);

  afterAll(async () => {
    configuration.CALENDAR_CONNECTOR_URL = originalCalendarUrl;
    await sidecar.close();
    await server.close();
  });

  async function calendarToolSet(): Promise<IToolSet> {
    const store = new SqliteMcpServerStore(server.db());
    const resolver = new TurnResourceResolver({
      llm: () =>
        Promise.resolve({
          modelClient: {
            create: () =>
              (async function* () {
                await Promise.resolve();
                throw new Error('no model is called');
              })(),
            createNonStream: () => Promise.reject(new Error('no model is called')),
          },
          defaultModelParams: {},
          modelId: undefined,
          modelSupportsVision: false,
        }),
      // The same lookup the server's turn route hands the resolver.
      mcp: async name => {
        const connection = await getMcpConnection({ tenant_id: TENANT, name, store, userRef: OWNER });
        if (connection === undefined) {
          throw new Error(`no connector named ${name}`);
        }
        return {
          url: connection.url,
          headers: withGatewayMetadataHeaders({ headers: connection.headers, metadataHeaders: {} }),
          first_party: connection.first_party,
        };
      },
      mcpRequestTimeoutMs: 10_000,
      mcpConnectTimeoutMs: 10_000,
      logger: createLogger({ silent: true }),
    });
    const resolved = await resolver.resolveAgentDefinition({
      spec: AgentSpecSchema.parse({
        model: { name: 'scripted/chat-model' },
        instructions: 'Answer the user.',
        mcp_servers: [{ name: 'Calendar', preload: true }],
      }),
      signal: new AbortController().signal,
      tracing: resolver.createTracing(),
      tenant_id: TENANT,
      created_by: OWNER,
      session_id: 's1',
    });
    const calendar = resolved.definition.toolSets?.find(toolSet => toolSet.name === 'Calendar');
    if (calendar === undefined) {
      throw new Error('expected the Calendar connector to be mounted');
    }
    return calendar;
  }

  async function saveUnmarked({ name }: { name: string }): Promise<void> {
    await new SqliteMcpServerStore(server.db()).upsertServer({
      tenant_id: TENANT,
      name,
      manifest: { type: 'remote', name, url: sidecar.url, description: 'Imported.' },
      first_party: false,
    });
  }

  it('reads the calendar with no card from an unmarked record, while changes still ask', async () => {
    await saveUnmarked({ name: 'Calendar' });
    const calendar = await calendarToolSet();

    const read = await calendar.toolCallInfo({ name: 'list_events', arguments: {} }, true);
    expect({ tier: read.tier, asks: read.is_approval_required }).toEqual({ tier: 1, asks: false });

    for (const call of [
      { name: 'delete_event', arguments: { id: 'e1' } },
      { name: 'update_event', arguments: { id: 'e1', summary: 'Lunch' } },
    ]) {
      const change = await calendar.toolCallInfo(call, true);
      expect({ name: call.name, asks: change.is_approval_required }).toEqual({ name: call.name, asks: true });
    }
  });

  it('does not trust the same address under another name', async () => {
    await saveUnmarked({ name: 'My calendar' });
    const connection = await getMcpConnection({
      tenant_id: TENANT,
      name: 'My calendar',
      store: new SqliteMcpServerStore(server.db()),
      userRef: OWNER,
    });
    expect(connection?.first_party).toBe(false);
  });
});
