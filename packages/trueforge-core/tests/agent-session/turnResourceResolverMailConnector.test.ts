import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AgentSpecSchema, type AgentSpec } from '../../src/agent-session/schemas/agentSpec';
import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import { MailAccountDirectory } from '../../src/core/email/mailConnector/MailConnectorSource';
import { MAIL_CONNECTOR_NAME } from '../../src/core/email/mailConnector/toolContract';
import type { ApprovalDecision } from '../../src/core/events/schema';
import { isCallToolResponseResult, type CallToolResponse, type IToolSet } from '../../src/core/mcp/IMCPServer';
import { connectRemoteMcp } from '../../src/core/mcp/remoteMcpClient';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeMockILLM, makeSilentLogger } from './testHelpers';

jest.mock('../../src/core/mcp/remoteMcpClient', () => {
  const actual = jest.requireActual<typeof import('../../src/core/mcp/remoteMcpClient')>(
    '../../src/core/mcp/remoteMcpClient',
  );
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = jest.mocked(connectRemoteMcp);

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/** Invented mail: two messages this week, three more within the month, and older ones. */
const MAILBOX = [1, 2, 9, 12, 20, 45, 90].map(daysAgo => ({
  email_id: `id-${String(daysAgo)}`,
  subject: `Message from ${String(daysAgo)} days ago`,
  sender: 'sender@example.com',
  date: new Date(NOW - daysAgo * DAY_MS).toISOString(),
}));

const readAnnotations = { readOnlyHint: true, openWorldHint: false };
const accountProperty = { type: 'string', description: 'The name of the email account.' };
/** Like the real sidecar, which declares its dates as `datetime | None`, so null is valid input. */
const nullableDate = { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }], default: null };

const SIDECAR_TOOLS = [
  {
    name: 'list_emails_metadata',
    description: 'List email metadata.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_name: accountProperty,
        mailbox: { type: 'string' },
        page: { type: 'integer' },
        page_size: { type: 'integer' },
        since: nullableDate,
        before: nullableDate,
        order: { type: 'string' },
      },
      required: ['account_name'],
    },
    annotations: readAnnotations,
  },
  {
    name: 'list_mailboxes',
    description: 'List mailboxes.',
    inputSchema: { type: 'object' as const, properties: { account_name: accountProperty }, required: ['account_name'] },
    annotations: readAnnotations,
  },
  {
    name: 'send_email',
    description: 'Send an email.',
    inputSchema: {
      type: 'object' as const,
      properties: { account_name: accountProperty, recipients: { type: 'array' }, subject: { type: 'string' } },
      required: ['account_name', 'recipients', 'subject'],
    },
  },
  {
    name: 'save_draft',
    description: 'Save a draft email.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_name: accountProperty,
        recipients: { type: 'array' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['account_name', 'recipients', 'subject'],
    },
  },
  {
    name: 'list_available_accounts',
    description: 'List accounts.',
    inputSchema: { type: 'object' as const, properties: {} },
    annotations: readAnnotations,
  },
];

function text(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

/**
 * A scripted sidecar, by default with one account named 'default'. Like the real one it refuses an unknown
 * account name, and it refuses any metadata search with no lower date bound as too broad.
 */
function scriptedSidecar({
  accountList,
  known = () => ['default'],
  draftResult = () => text({ ok: true, draft_id: 'draft-1' }),
}: {
  accountList: () => CallToolResult;
  known?: () => readonly string[];
  draftResult?: () => CallToolResult;
}) {
  const calls: Record<string, unknown>[] = [];
  const callTool = (params: CallToolRequest['params']): Promise<CallToolResult> => {
    const args = params.arguments ?? {};
    calls.push({ tool: params.name, ...args });
    if (params.name === 'list_available_accounts') {
      return Promise.resolve(accountList());
    }
    if (!known().some(name => name === args['account_name'])) {
      return Promise.resolve(text(`Account ${String(args['account_name'])} was not found`, true));
    }
    if (params.name === 'list_mailboxes') {
      return Promise.resolve(text({ mailboxes: ['INBOX', 'Sent'] }));
    }
    if (params.name === 'send_email') {
      return Promise.resolve(text({ sent: true }));
    }
    if (params.name === 'save_draft') {
      return Promise.resolve(draftResult());
    }
    const since = args['since'];
    if (since === undefined || since === null) {
      return Promise.resolve(text('query_too_broad: metadata search exceeded 10000 candidate UIDs', true));
    }
    const pageSize = typeof args['page_size'] === 'number' ? args['page_size'] : 10;
    const before = args['before'];
    const emails = MAILBOX.filter(email => typeof since !== 'string' || email.date >= since)
      .filter(email => typeof before !== 'string' || email.date < before)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, pageSize);
    return Promise.resolve(text({ emails, total: emails.length }));
  };
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools: SIDECAR_TOOLS }),
      callTool,
      close: () => Promise.resolve(),
    }),
  );
  return { calls };
}

function makeResolver(mailAccounts: MailAccountDirectory) {
  return new TurnResourceResolver({
    llm: () =>
      Promise.resolve({
        modelClient: makeMockILLM(),
        defaultModelParams: {},
        modelId: undefined,
        modelSupportsVision: false,
      }),
    mcp: () => Promise.resolve({ url: 'https://mail-email.example.com/mcp', first_party: true }),
    mcpRequestTimeoutMs: 1_000,
    mcpConnectTimeoutMs: 1_000,
    logger: makeSilentLogger(),
    mailAccounts,
  });
}

function makeSpec(): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: 'test-provider/test-model' },
    instructions: 'test',
    mcp_servers: [
      {
        name: MAIL_CONNECTOR_NAME,
        enable_tools: ['list_emails_metadata', 'list_mailboxes', 'send_email', 'save_draft'],
      },
    ],
    config: {
      ask_user_questions: { enabled: false },
      dynamic_sub_agents: { enabled: false },
      generative_ui: { enabled: false },
      context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
    },
  });
}

async function emailToolSet(resolver: TurnResourceResolver, session_id = 'chat-1'): Promise<IToolSet> {
  const { definition } = await resolver.resolveAgentDefinition({
    spec: makeSpec(),
    signal: new AbortController().signal,
    tracing: NOOP_AGENT_TRACING,
    tenant_id: 'tenant-1',
    created_by: 'user-1',
    session_id,
  });
  const [toolSet] = definition.toolSets ?? [];
  if (toolSet === undefined) {
    throw new Error('no Email tool set resolved');
  }
  return toolSet;
}

function resultText(response: CallToolResponse): { text: string; isError: boolean } {
  if (!isCallToolResponseResult(response)) {
    throw new Error('Expected a tool result');
  }
  const [first] = response.result.content;
  if (first === undefined || first.type !== 'text') {
    throw new Error('Expected text content');
  }
  return { text: first.text, isError: response.result.isError === true };
}

const ListedEmailsSchema = z.object({ emails: z.array(z.object({ email_id: z.string() })) });

/** The person approved the card, so the write reaches the Email connector. */
const APPROVED: ApprovalDecision = { status: 'allow' };

const oneAccount = () => text({ account_name: 'default', email_address: 'owner@example.com' });

describe('Email connector account name', () => {
  beforeEach(() => {
    mockConnect.mockReset();
  });

  it('reaches the one account when the model gives no account name and when it guesses a wrong one', async () => {
    const sidecar = scriptedSidecar({ accountList: oneAccount });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));

    const missing = resultText(await toolSet.callTool({ name: 'list_mailboxes', arguments: {} }));
    const wrong = resultText(await toolSet.callTool({ name: 'list_mailboxes', arguments: { account_name: 'sidd' } }));

    expect(missing.isError).toBe(false);
    expect(wrong.isError).toBe(false);
    const mailboxCalls = sidecar.calls.filter(call => call['tool'] === 'list_mailboxes');
    expect(mailboxCalls.map(call => call['account_name'])).toEqual(['default', 'default']);
  });

  it('reads the account list once per chat for reads, across turns', async () => {
    const sidecar = scriptedSidecar({ accountList: oneAccount });
    const directory = new MailAccountDirectory();
    for (const account_name of [undefined, 'default']) {
      const toolSet = await emailToolSet(makeResolver(directory));
      await toolSet.callTool({ name: 'list_mailboxes', arguments: { account_name } });
    }

    expect(sidecar.calls.filter(call => call['tool'] === 'list_available_accounts')).toHaveLength(1);
  });

  it('sends nothing and says so plainly when the account list cannot be read', async () => {
    const sidecar = scriptedSidecar({ accountList: () => text('sidecar starting', true) });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));

    const { text: said, isError } = resultText(await toolSet.callTool({ name: 'list_mailboxes', arguments: {} }));

    expect(isError).toBe(true);
    expect(said).toContain('The list of Email accounts could not be read');
    expect(sidecar.calls.filter(call => call['tool'] === 'list_mailboxes')).toEqual([]);
  });

  it('lists the real names in one line when there are several accounts and the name is unknown', async () => {
    scriptedSidecar({
      accountList: () => ({
        content: [
          { type: 'text', text: JSON.stringify({ account_name: 'work' }) },
          { type: 'text', text: JSON.stringify({ account_name: 'home' }) },
        ],
      }),
    });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));

    const { text: said } = resultText(
      await toolSet.callTool({ name: 'list_mailboxes', arguments: { account_name: 'main' } }),
    );

    expect(JSON.parse(said)).toEqual({
      error:
        "There is no Email account named 'main'. The accounts are 'work', 'home'; use one of these names, or leave the name out when there is one account.",
    });
  });

  it('refuses a send that names an account not on the list, even with one account, and sends nothing', async () => {
    const sidecar = scriptedSidecar({ accountList: oneAccount });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));

    const { text: said, isError } = resultText(
      await toolSet.callTool(
        {
          name: 'send_email',
          arguments: { account_name: 'work', recipients: ['friend@example.com'], subject: 'Hello' },
        },
        APPROVED,
      ),
    );

    expect(isError).toBe(true);
    expect(said).toContain("There is no Email account named 'work'.");
    expect(sidecar.calls.filter(call => call['tool'] === 'send_email')).toEqual([]);
  });

  it('fills the one account into a send that leaves the name out', async () => {
    const sidecar = scriptedSidecar({ accountList: oneAccount });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));

    await toolSet.callTool(
      { name: 'send_email', arguments: { recipients: ['friend@example.com'], subject: 'Hi' } },
      APPROVED,
    );

    const sends = sidecar.calls.filter(call => call['tool'] === 'send_email');
    expect(sends.map(call => call['account_name'])).toEqual(['default']);
  });

  it('reads the account list again for a send, so an account added since the last read is used', async () => {
    const accounts = ['default'];
    const sidecar = scriptedSidecar({
      accountList: () => text(accounts.map(account_name => ({ account_name }))),
      known: () => accounts,
    });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));
    await toolSet.callTool({ name: 'list_mailboxes', arguments: {} });
    accounts.push('work');

    const { isError } = resultText(
      await toolSet.callTool(
        {
          name: 'send_email',
          arguments: { account_name: 'work', recipients: ['friend@example.com'], subject: 'Hello' },
        },
        APPROVED,
      ),
    );

    expect(isError).toBe(false);
    const sends = sidecar.calls.filter(call => call['tool'] === 'send_email');
    expect(sends.map(call => call['account_name'])).toEqual(['work']);
    expect(sidecar.calls.filter(call => call['tool'] === 'list_available_accounts')).toHaveLength(2);
  });

  it('keeps each connector address apart in the same chat', async () => {
    const directory = new MailAccountDirectory();
    const read = jest.fn(() => Promise.resolve(['default']));

    await directory.accounts({ chat_id: 'chat-1', connector_url: 'https://a.example.com/mcp', fresh: false, read });
    await directory.accounts({ chat_id: 'chat-1', connector_url: 'https://b.example.com/mcp', fresh: false, read });
    await directory.accounts({ chat_id: 'chat-1', connector_url: 'https://a.example.com/mcp', fresh: false, read });

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never asks the model for the account name in the tool list', async () => {
    scriptedSidecar({ accountList: oneAccount });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));

    const first = await toolSet.listTools();
    const second = await toolSet.listTools();

    if (!('result' in first) || !('result' in second)) {
      throw new Error('Expected a tool list');
    }
    expect(first.result.tools).toEqual(second.result.tools);
    for (const tool of first.result.tools) {
      expect(tool.inputSchema.required ?? []).not.toContain('account_name');
    }
  });
});

describe('Email connector drafts', () => {
  beforeEach(() => {
    mockConnect.mockReset();
  });

  it('tells the model a draft keeps the recipients the person named', async () => {
    scriptedSidecar({ accountList: oneAccount });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));

    const listed = await toolSet.listTools();
    if (!('result' in listed)) {
      throw new Error('Expected a tool list');
    }
    const draft = listed.result.tools.find(tool => tool.name === 'save_draft');
    expect(draft?.description).toContain('Recipients the person named must stay on the call');
    expect(draft?.description).toContain('an approval card shown to the person');
    expect(draft?.description).toContain('a draft with no recipient is refused');
    expect(draft?.description ?? '').not.toContain('allowlist');
  });

  it('answers the sidecar recipient refusal in plain words, naming the card as the route', async () => {
    scriptedSidecar({
      accountList: oneAccount,
      draftResult: () => text('Error executing tool save_draft: recipient policy denied one or more addresses', true),
    });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));

    const { text: said, isError } = resultText(
      await toolSet.callTool(
        { name: 'save_draft', arguments: { recipients: ['new@example.com'], subject: 'Hi', body: 'Hello' } },
        APPROVED,
      ),
    );

    expect(isError).toBe(true);
    expect(said).not.toContain('recipient policy denied');
    expect(said).toContain('Nothing was saved or sent');
    expect(said).toContain('so the person can be asked on a card');
  });

  it('passes a saved draft result through as it came', async () => {
    scriptedSidecar({ accountList: oneAccount });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));

    const { text: said, isError } = resultText(
      await toolSet.callTool(
        { name: 'save_draft', arguments: { recipients: ['friend@example.com'], subject: 'Hi' } },
        APPROVED,
      ),
    );

    expect(isError).toBe(false);
    expect(JSON.parse(said)).toEqual({ ok: true, draft_id: 'draft-1' });
  });
});

describe('Email connector newest messages', () => {
  beforeEach(() => {
    mockConnect.mockReset();
  });

  it('answers a newest-three request with no date from a bounded window, never a whole-mailbox scan', async () => {
    const sidecar = scriptedSidecar({ accountList: oneAccount });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));

    const { text: said, isError } = resultText(
      await toolSet.callTool({ name: 'list_emails_metadata', arguments: { page_size: 3 } }),
    );

    expect(isError).toBe(false);
    expect(said).not.toContain('query_too_broad');
    const { emails } = ListedEmailsSchema.parse(JSON.parse(said));
    expect(emails.map(email => email.email_id)).toEqual(['id-1', 'id-2', 'id-9']);
    const listCalls = sidecar.calls.filter(call => call['tool'] === 'list_emails_metadata');
    // The last week held two messages, so the window widened once to the last month.
    expect(listCalls).toHaveLength(2);
    for (const call of listCalls) {
      expect(typeof call['since']).toBe('string');
      expect(call['order']).toBe('desc');
    }
  });

  it.each([
    ['a null since', { since: null }],
    ['a null since and before', { since: null, before: null }],
  ])('treats %s as no date and still bounds the list', async (_label, dates) => {
    const sidecar = scriptedSidecar({ accountList: oneAccount });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));

    const { text: said, isError } = resultText(
      await toolSet.callTool({ name: 'list_emails_metadata', arguments: { ...dates, page_size: 3 } }),
    );

    expect(isError).toBe(false);
    expect(said).not.toContain('query_too_broad');
    const listCalls = sidecar.calls.filter(call => call['tool'] === 'list_emails_metadata');
    for (const call of listCalls) {
      expect(typeof call['since']).toBe('string');
      expect(call['before']).toBeUndefined();
    }
  });

  it('adds a lower bound counted back from before when only before is set', async () => {
    const sidecar = scriptedSidecar({ accountList: oneAccount });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));
    const before = new Date(NOW - 10 * DAY_MS).toISOString();

    const { isError } = resultText(
      await toolSet.callTool({ name: 'list_emails_metadata', arguments: { before, page_size: 3 } }),
    );

    expect(isError).toBe(false);
    const listCalls = sidecar.calls.filter(call => call['tool'] === 'list_emails_metadata');
    expect(listCalls.map(call => call['since'])).toEqual([
      new Date(NOW - 17 * DAY_MS).toISOString(),
      new Date(NOW - 40 * DAY_MS).toISOString(),
    ]);
    for (const call of listCalls) {
      expect(call['before']).toBe(before);
    }
  });

  it('keeps a date the model set', async () => {
    const sidecar = scriptedSidecar({ accountList: oneAccount });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));
    const since = new Date(NOW - 100 * DAY_MS).toISOString();

    await toolSet.callTool({ name: 'list_emails_metadata', arguments: { since, page_size: 3 } });

    const listCalls = sidecar.calls.filter(call => call['tool'] === 'list_emails_metadata');
    expect(listCalls.map(call => call['since'])).toEqual([since]);
  });

  it('says in the tool description that results are newest first within the window', async () => {
    scriptedSidecar({ accountList: oneAccount });
    const toolSet = await emailToolSet(makeResolver(new MailAccountDirectory()));

    const listed = await toolSet.listTools();
    if (!('result' in listed)) {
      throw new Error('Expected a tool list');
    }
    const listTool = listed.result.tools.find(tool => tool.name === 'list_emails_metadata');
    expect(listTool?.description).toContain('Results are newest first within that window.');
  });
});
