import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { MAIL_CONNECTOR_TOOL_NAMES, MAIL_READ_TOOL_NAMES } from '../../../../src/core/email/mailConnector/toolContract';
import { ToolSelectorPolicy } from '../../../../src/core/mcp/ToolSelectorPolicy';

/** The sidecar's 21 tools, as the research on the pinned release listed them. The 13 not offered are hidden. */
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

/** Stateless MCP endpoint scripted with the sidecar's tool names; no mail is read or sent. */
function startSidecarStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const http: Server = createServer((request, response) => {
    const server = new McpServer({ name: 'mail-email-stub', version: '0.0.0' });
    for (const name of SIDECAR_TOOL_NAMES) {
      server.registerTool(
        name,
        {
          description: `Scripted ${name}.`,
          annotations: { readOnlyHint: MAIL_READ_TOOL_NAMES.some(read => read === name) },
        },
        () => ({ content: [{ type: 'text', text: `${name} ran` }] }),
      );
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    void server.connect(transport).then(() => transport.handleRequest(request, response));
  });
  return new Promise(resolve => {
    http.listen(0, '127.0.0.1', () => {
      const { port } = http.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}/mcp`,
        close: () => new Promise(done => http.close(() => done())),
      });
    });
  });
}

describe('Email connector against a scripted sidecar', () => {
  let stub: { url: string; close: () => Promise<void> };
  let tools: Tool[];

  beforeAll(async () => {
    stub = await startSidecarStub();
    const client = new Client({ name: 'aman-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(stub.url)));
    tools = (await client.listTools()).tools;
    await client.close();
  });

  afterAll(async () => {
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

  it('the sidecar lists all 21 of its tools', () => {
    expect(tools.map(tool => tool.name).sort()).toEqual([...SIDECAR_TOOL_NAMES].sort());
  });

  it('the model is offered exactly the 8 Email tools and no other', () => {
    const offered = policy()
      .filterAndAnnotate(tools.map(tool => ({ ...tool, preload: true })))
      .map(tool => tool.name);
    expect(offered).toHaveLength(8);
    expect([...offered].sort()).toEqual([...MAIL_CONNECTOR_TOOL_NAMES].sort());
  });

  it('the 13 hidden tools cannot be called', async () => {
    const hidden = SIDECAR_TOOL_NAMES.filter(name => !MAIL_CONNECTOR_TOOL_NAMES.some(allowed => allowed === name));
    expect(hidden).toHaveLength(13);
    const p = policy();
    p.filterAndAnnotate(tools.map(tool => ({ ...tool, preload: true })));
    for (const name of hidden) {
      await expect(p.isAllowed(name, () => Promise.resolve(undefined))).resolves.toBe(false);
    }
  });

  it('every offered tool can be called', async () => {
    const p = policy();
    p.filterAndAnnotate(tools.map(tool => ({ ...tool, preload: true })));
    for (const name of MAIL_CONNECTOR_TOOL_NAMES) {
      await expect(p.isAllowed(name, () => Promise.resolve(undefined))).resolves.toBe(true);
    }
  });
});
