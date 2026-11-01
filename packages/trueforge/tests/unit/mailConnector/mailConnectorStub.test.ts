import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  MAIL_CONNECTOR_TOOL_NAMES,
  MAIL_READ_TOOL_NAMES,
} from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import { connectRemoteMcp, type RemoteMcpConnection } from '@truefoundry/trueforge-core/core/mcp/remoteMcpClient';
import { ToolSelectorPolicy } from '@truefoundry/trueforge-core/core/mcp/ToolSelectorPolicy';

import { asTransport } from '../../fixtures/inertMcpServer';

/** The sidecar's 21 tools, as the research on the pinned release listed them. 13 are not offered. */
const SIDECAR_TOOL_NAMES = [
  ...MAIL_CONNECTOR_TOOL_NAMES,
  'list_available_accounts',
  'list_email_tags',
  'list_allowed_recipients',
  'list_allowed_senders',
  'set_email_flags',
  'set_email_tags',
  'mark_emails_as_read',
  'create_mailbox',
  'save_to_mailbox',
  'delete_emails',
  'move_emails',
  'download_attachment',
  'email_command',
];

/** A scripted sidecar over Streamable HTTP. Every tool returns a fixed text; no mail is read or sent. */
async function startSidecarStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const mcp = new McpServer({ name: 'mail-email-stub', version: '0.0.0' });
  for (const name of SIDECAR_TOOL_NAMES) {
    mcp.registerTool(
      name,
      {
        description: `Scripted ${name}.`,
        annotations: { readOnlyHint: MAIL_READ_TOOL_NAMES.some(read => read === name) },
      },
      () => ({ content: [{ type: 'text', text: `${name} ran` }] }),
    );
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await mcp.connect(asTransport(transport));
  const http: Server = createServer((request, response) => {
    void transport.handleRequest(request, response);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    close: () =>
      new Promise(done => {
        http.close(() => done());
      }),
  };
}

describe('Email connector against a scripted sidecar', () => {
  let stub: { url: string; close: () => Promise<void> };
  let connection: RemoteMcpConnection;

  beforeAll(async () => {
    stub = await startSidecarStub();
    connection = await connectRemoteMcp({
      url: stub.url,
      headers: {},
      requestTimeoutMs: 10_000,
      connectTimeoutMs: 10_000,
      signal: new AbortController().signal,
    });
  });

  afterAll(async () => {
    await connection?.close();
    await stub.close();
  });

  const policy = () =>
    new ToolSelectorPolicy({
      selectors: {
        enableTools: [...MAIL_CONNECTOR_TOOL_NAMES],
        disableTools: [],
        preloadTools: [],
        requireApprovalForTools: undefined,
      },
      preload: true,
    });

  it('the sidecar lists its 21 tools through the production client', async () => {
    const { tools } = await connection.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual([...SIDECAR_TOOL_NAMES].sort());
  });

  it('the model is offered exactly the 8 Email tools, and each name exists on the sidecar', async () => {
    const { tools } = await connection.listTools();
    const selector = policy();
    const offered = selector.filterAndAnnotate(tools.map(tool => ({ ...tool, preload: true })));
    expect([...offered.map(tool => tool.name)].sort()).toEqual([...MAIL_CONNECTOR_TOOL_NAMES].sort());
    expect(selector.missingEnableLiterals(tools.map(tool => ({ ...tool, preload: true })))).toEqual([]);
  });

  it('the 13 hidden tools cannot be called, and every offered tool can', async () => {
    const { tools } = await connection.listTools();
    const selector = policy();
    selector.filterAndAnnotate(tools.map(tool => ({ ...tool, preload: true })));
    const hidden = SIDECAR_TOOL_NAMES.filter(name => !MAIL_CONNECTOR_TOOL_NAMES.some(allowed => allowed === name));
    expect(hidden).toHaveLength(13);
    for (const name of hidden) {
      await expect(selector.isAllowed(name, () => Promise.resolve(undefined))).resolves.toBe(false);
    }
    for (const name of MAIL_CONNECTOR_TOOL_NAMES) {
      await expect(selector.isAllowed(name, () => Promise.resolve(undefined))).resolves.toBe(true);
    }
  });

  it('an offered tool returns the sidecar result through the production client', async () => {
    const result = await connection.callTool({ name: 'list_mailboxes', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'list_mailboxes ran' }]);
  });
});
