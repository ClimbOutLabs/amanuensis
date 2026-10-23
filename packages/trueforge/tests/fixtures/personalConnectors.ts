/**
 * Fake Email and Calendar connectors, shaped after the mail and calendar sidecars a real install runs
 * beside Aman. One HTTP server answers both over Streamable HTTP MCP, each at its own path, from a few
 * invented messages and events. Nothing is ever sent or written: every call is only counted.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { z } from 'zod';
import { asTransport } from './inertMcpServer';

const MAIL_ACCOUNT_EMAIL = 'rowan@example.com';
/** A contact whose address only the mail carries. */
export const MAIL_CONTACT_EMAIL = 'juniper.okafor@example.net';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Invented mail, newest first. */
function inventedMessages(now: Date) {
  return [
    {
      email_id: 'mail-3',
      subject: 'Book club on Thursday',
      sender: `Juniper Okafor <${MAIL_CONTACT_EMAIL}>`,
      date: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      body: 'We moved book club to Thursday at 7. Bring the second novel.',
    },
    {
      email_id: 'mail-2',
      subject: 'Your library hold is ready',
      sender: 'Riverside Library <holds@library.example.org>',
      date: new Date(now.getTime() - DAY_MS).toISOString(),
      body: 'The book you asked for is waiting at the front desk for seven days.',
    },
    {
      email_id: 'mail-1',
      subject: 'Garden plot renewal',
      sender: 'Hillcrest Community Garden <plots@garden.example.org>',
      date: new Date(now.getTime() - 3 * DAY_MS).toISOString(),
      body: 'Renew your plot by the end of the month to keep it for next season.',
    },
  ];
}

/** Invented events for today, in the server's own day. */
function inventedEvents(now: Date) {
  const day = now.toISOString().slice(0, 10);
  return [
    { id: 'event-1', summary: 'Dentist check-up', start: `${day}T09:30:00Z`, end: `${day}T10:00:00Z` },
    { id: 'event-2', summary: 'Lunch with Sam', start: `${day}T12:30:00Z`, end: `${day}T13:30:00Z` },
    { id: 'event-3', summary: 'Pick up groceries', start: `${day}T17:00:00Z`, end: `${day}T17:30:00Z` },
  ];
}

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, openWorldHint: true };
const optionalDate = z.string().nullable().optional();

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function buildMailServer(count: (tool: string) => void): McpServer {
  const server = new McpServer({ name: 'fake-mail', version: '0.0.0' });
  const account = { account_name: z.string() };
  server.registerTool(
    'list_available_accounts',
    { description: 'List the mail accounts.', inputSchema: {}, annotations: READ },
    () => {
      count('list_available_accounts');
      return json({ account_name: 'default', email_address: MAIL_ACCOUNT_EMAIL });
    },
  );
  server.registerTool(
    'list_emails_metadata',
    {
      description: 'List email metadata, newest first.',
      inputSchema: {
        ...account,
        mailbox: z.string().optional(),
        since: optionalDate,
        before: optionalDate,
        limit: z.number().optional(),
      },
      annotations: READ,
    },
    ({ limit }) => {
      count('list_emails_metadata');
      const emails = inventedMessages(new Date()).map(({ email_id, subject, sender, date }) => ({
        email_id,
        subject,
        sender,
        date,
      }));
      return json({ emails: emails.slice(0, limit ?? emails.length) });
    },
  );
  server.registerTool(
    'get_emails_content',
    {
      description: 'Read the full content of emails by id.',
      inputSchema: { ...account, email_ids: z.array(z.string()), mailbox: z.string().optional() },
      annotations: READ,
    },
    ({ email_ids }) => {
      count('get_emails_content');
      return json({ emails: inventedMessages(new Date()).filter(mail => email_ids.includes(mail.email_id)) });
    },
  );
  server.registerTool(
    'list_mailboxes',
    { description: 'List the mailboxes.', inputSchema: account, annotations: READ },
    () => {
      count('list_mailboxes');
      return json({ mailboxes: ['INBOX', 'Sent'] });
    },
  );
  server.registerTool(
    'get_attachment_content',
    {
      description: 'Read one attachment.',
      inputSchema: { ...account, email_id: z.string(), attachment_id: z.string() },
      annotations: READ,
    },
    () => {
      count('get_attachment_content');
      return json({ error: 'no attachment' });
    },
  );
  for (const tool of ['save_draft', 'forward_email', 'archive_emails']) {
    server.registerTool(
      tool,
      { description: `Pretends to ${tool.replaceAll('_', ' ')}.`, inputSchema: account, annotations: WRITE },
      () => {
        count(tool);
        return json({ done: true });
      },
    );
  }
  server.registerTool(
    'send_email',
    {
      description: 'Send an email.',
      inputSchema: { ...account, recipients: z.array(z.string()), subject: z.string(), body: z.string() },
      annotations: WRITE,
    },
    () => {
      count('send_email');
      return json({ sent: true });
    },
  );
  return server;
}

function buildCalendarServer(count: (tool: string) => void): McpServer {
  const server = new McpServer({ name: 'fake-calendar', version: '0.0.0' });
  server.registerTool(
    'list_calendars',
    { description: 'List the calendars.', inputSchema: {}, annotations: READ },
    () => {
      count('list_calendars');
      return json({ calendars: [{ id: 'personal', name: 'Personal' }] });
    },
  );
  server.registerTool(
    'list_events',
    {
      description: 'List events between two times.',
      inputSchema: { calendar_id: z.string().optional(), start: z.string().optional(), end: z.string().optional() },
      annotations: READ,
    },
    () => {
      count('list_events');
      return json({ events: inventedEvents(new Date()) });
    },
  );
  server.registerTool(
    'get_event',
    { description: 'Read one event.', inputSchema: { id: z.string() }, annotations: READ },
    ({ id }) => {
      count('get_event');
      return json({ event: inventedEvents(new Date()).find(event => event.id === id) ?? null });
    },
  );
  server.registerTool(
    'search_events',
    { description: 'Search events by text.', inputSchema: { query: z.string() }, annotations: READ },
    () => {
      count('search_events');
      return json({ events: inventedEvents(new Date()) });
    },
  );
  for (const tool of ['update_event', 'delete_event', 'respond_to_event']) {
    server.registerTool(
      tool,
      { description: `Pretends to ${tool.replaceAll('_', ' ')}.`, inputSchema: { id: z.string() }, annotations: WRITE },
      () => {
        count(tool);
        return json({ done: true });
      },
    );
  }
  server.registerTool(
    'create_event',
    {
      description: 'Create an event.',
      inputSchema: {
        calendar_id: z.string().optional(),
        summary: z.string(),
        start: z.string(),
        end: z.string(),
        attendees: z.array(z.string()).optional(),
      },
      annotations: WRITE,
    },
    () => {
      count('create_event');
      return json({ created: true, id: 'event-new' });
    },
  );
  return server;
}

export interface PersonalConnectors {
  /** Origin both connectors answer on: what an operator lists as first-party. */
  origin: string;
  mailUrl: string;
  calendarUrl: string;
  /** Times each tool ran, by tool name, across both connectors. */
  invocations: (tool: string) => number;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', error => {
      reject(new Error('fake connector could not read the request body', { cause: error }));
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw.length === 0 ? undefined : JSON.parse(raw));
      } catch (error) {
        reject(new Error('fake connector received a non-JSON body', { cause: error }));
      }
    });
  });
}

export async function startPersonalConnectors(): Promise<PersonalConnectors> {
  const counts = new Map<string, number>();
  const count = (tool: string) => counts.set(tool, (counts.get(tool) ?? 0) + 1);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const builders = new Map([
    ['/email', () => buildMailServer(count)],
    ['/calendar', () => buildCalendarServer(count)],
  ]);

  const httpServer: Server = createServer((req, res) => {
    void (async () => {
      const sessionHeader = req.headers['mcp-session-id'];
      const existing = typeof sessionHeader === 'string' ? transports.get(sessionHeader) : undefined;
      if (existing !== undefined) {
        await existing.handleRequest(req, res);
        return;
      }
      const build = builders.get(new URL(req.url ?? '/', 'http://fake').pathname);
      const body = await readBody(req);
      if (build === undefined || !isInitializeRequest(body)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'fake connector expects an initialize request on /email or /calendar' }));
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: id => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId !== undefined) {
          transports.delete(transport.sessionId);
        }
      };
      await build().connect(asTransport(transport));
      await transport.handleRequest(req, res, body);
    })().catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'fake connector failed' }));
    });
  });
  await new Promise<void>(resolve => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake connectors did not bind a TCP port');
  }
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    origin,
    mailUrl: `${origin}/email`,
    calendarUrl: `${origin}/calendar`,
    invocations: tool => counts.get(tool) ?? 0,
    close: async () => {
      for (const transport of transports.values()) {
        await transport.close();
      }
      httpServer.closeAllConnections();
      await new Promise<void>(resolve => {
        httpServer.close(() => {
          resolve();
        });
      });
    },
  };
}
