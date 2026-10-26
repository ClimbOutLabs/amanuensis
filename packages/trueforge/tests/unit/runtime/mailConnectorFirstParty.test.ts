/**
 * The Email connector over the real route: registered at boot as a terminal install does, loaded by the server's own
 * connection lookup, and mounted by the real turn resolver. The sidecar publishes no tool annotations, so its reads
 * must run on the host's own word that they are reads, while its sends still ask.
 */
import { AgentSpecSchema, TurnResourceResolver } from '@truefoundry/trueforge-core/agent-session';
import { allowsChatApproval } from '@truefoundry/trueforge-core/core/mcp/approvalGrant';
import type { IToolSet } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { createLogger } from 'winston';
import configuration from '../../../src/config';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { registerMailConnector } from '../../../src/runtime/mailConnector';
import { getMcpConnection, withGatewayMetadataHeaders } from '../../../src/runtime/sessionResources';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { startInertMcpServer, type InertMcpServer } from '../../fixtures/inertMcpServer';

const TENANT = 'default';
const OWNER = 'owner-1';

describe('the Email connector on the real tool route', () => {
  let server: ApprovalTestServer;
  let sidecar: InertMcpServer;
  const originalMailUrl = configuration.MAIL_EMAIL_MCP_URL;

  beforeAll(async () => {
    server = await startApprovalTestServer();
    sidecar = await startInertMcpServer({ mail: true });
    // A terminal install: config lists the sidecar's origin as the operator's own.
    server.setFirstPartyOrigins([sidecar.origin]);
    configuration.MAIL_EMAIL_MCP_URL = sidecar.url;
  }, 120_000);

  afterAll(async () => {
    configuration.MAIL_EMAIL_MCP_URL = originalMailUrl;
    await sidecar.close();
    await server.close();
  });

  async function emailToolSet(gate: { require_approval_for_tools?: string[] } = {}): Promise<IToolSet> {
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
        mcp_servers: [{ name: 'Email', preload: true, ...gate }],
      }),
      signal: new AbortController().signal,
      tracing: resolver.createTracing(),
      tenant_id: TENANT,
      created_by: OWNER,
      session_id: 's1',
    });
    const email = resolved.definition.toolSets?.find(toolSet => toolSet.name === 'Email');
    if (email === undefined) {
      throw new Error('expected the Email connector to be mounted');
    }
    return email;
  }

  async function expectReadsRunAndSendsAsk(): Promise<void> {
    // The sidecar's tools carry no annotations, as the shipped image's do not.
    const email = await emailToolSet();
    for (const call of [
      { name: 'get_emails_content', arguments: { ids: ['m1'] } },
      { name: 'list_emails_metadata', arguments: { limit: 5 } },
      { name: 'list_emails_metadata', arguments: { from: 'dana@example.org', subject: 'book club' } },
      { name: 'list_mailboxes', arguments: {} },
    ]) {
      const info = await email.toolCallInfo(call, true);
      expect({ name: call.name, tier: info.tier, asks: info.is_approval_required }).toEqual({
        name: call.name,
        tier: 1,
        asks: false,
      });
    }
    const send = await email.toolCallInfo(
      { name: 'send_email', arguments: { to: ['dana@example.org'], subject: 'Friday', body: 'See you then.' } },
      true,
    );
    expect(send.is_approval_required).toBe(true);
    // A send asks every time: its card never offers "Always allow this here".
    expect(allowsChatApproval(send)).toBe(false);
  }

  it('reads, lists and searches mail with no card right after boot, and sending still asks', async () => {
    await registerMailConnector({
      url: sidecar.url,
      mcpServerStore: new SqliteMcpServerStore(server.db()),
      tenant_id: TENANT,
    });

    await expectReadsRunAndSendsAsk();
  });

  it('reads with no card from an Email record an import or an edit left without its mark', async () => {
    // Imports and Settings edits write the record with first_party false.
    await new SqliteMcpServerStore(server.db()).upsertServer({
      tenant_id: TENANT,
      name: 'Email',
      manifest: { type: 'remote', name: 'Email', url: sidecar.url, description: 'Imported.' },
      first_party: false,
    });

    await expectReadsRunAndSendsAsk();
  });

  it('still asks for a read when the person chose to approve every Email tool', async () => {
    await registerMailConnector({
      url: sidecar.url,
      mcpServerStore: new SqliteMcpServerStore(server.db()),
      tenant_id: TENANT,
    });
    const email = await emailToolSet({ require_approval_for_tools: ['@all'] });

    const read = await email.toolCallInfo({ name: 'get_emails_content', arguments: { ids: ['m1'] } }, true);
    expect(read.is_approval_required).toBe(true);
  });
});
