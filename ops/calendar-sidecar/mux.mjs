// The calendar multiplexer: one MCP address in front of one CalDAV tool server per account.
// The tool server upstream serves a single account, so the supervisor runs one per saved account on
// loopback ports and this module fronts them all at the address the app connects to.
//
// How an account is named: calendar and event ids carry their account in front of a | sign, like
// alice@example.com|/dav/calendars/alice/personal/. The id an answer gives is the id the next call
// hands back, so an approval given on a call keeps acting on the account it was given on, and a call
// can never drift to another account. Every tool also takes an optional account argument. A read
// that names no account spans every connected account, and its answers say which account each
// calendar and event belongs to.
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';

const READ_TOOLS = new Set(['list_calendars', 'list_events', 'get_event', 'search_events']);
const WRITE_TOOLS = new Set(['create_event', 'update_event', 'delete_event', 'respond_to_event']);
const ID_KEYS = ['calendar_id', 'destination_calendar_id', 'id'];
const MAX_BODY_BYTES = 1_048_576;

const ACCOUNT_PROPERTY = {
  type: 'string',
  description:
    'The account this call belongs to, by its email address. Calendar and event ids name their ' +
    'account before a | sign. Leave this out unless the person means one account: reads then span ' +
    'every connected account, and a new event follows the calendar it names.',
};

/** The account an id names, or null when the id carries no known account prefix. */
function accountOfId(id, emails) {
  if (typeof id !== 'string') {
    return null;
  }
  const cut = id.indexOf('|');
  if (cut <= 0) {
    return null;
  }
  const head = id.slice(0, cut);
  return emails.includes(head) ? head : null;
}

function stripId(id, email) {
  return id.startsWith(`${email}|`) ? id.slice(email.length + 1) : id;
}

function prefixId(id, email) {
  return `${email}|${id}`;
}

/** Every account a call's arguments name, through the account argument and the ids it carries. */
function namedAccounts(args, emails) {
  const named = new Set();
  if (typeof args.account === 'string' && args.account !== '') {
    named.add(args.account);
  }
  for (const key of ID_KEYS) {
    const account = accountOfId(args[key], emails);
    if (account !== null) {
      named.add(account);
    }
  }
  if (Array.isArray(args.calendars)) {
    for (const ref of args.calendars) {
      const account = accountOfId(ref, emails);
      if (account !== null) {
        named.add(account);
      }
    }
  }
  return named;
}

/** The arguments as one account's tool server must see them: no routing arguments, no id prefixes. */
function argumentsForTarget(args, email) {
  const out = { ...args };
  delete out.account;
  delete out.limit_accounts;
  for (const key of ID_KEYS) {
    if (typeof out[key] === 'string') {
      out[key] = stripId(out[key], email);
    }
  }
  if (Array.isArray(out.calendars)) {
    out.calendars = out.calendars.map(ref => (typeof ref === 'string' ? stripId(ref, email) : ref));
  }
  return out;
}

/**
 * Prefixes the ids in one answer and tags each calendar and event with its account. Returns the
 * transformed structured content and the id replacements to apply to the text channel, where the
 * same ids appear as complete quoted strings.
 */
function tagResult(structured, email) {
  if (typeof structured !== 'object' || structured === null) {
    return { structured, replacements: [] };
  }
  const replacements = [];
  const tagEntry = entry => {
    if (typeof entry !== 'object' || entry === null) {
      return entry;
    }
    const out = { ...entry, account: email };
    if (typeof entry.id === 'string') {
      out.id = prefixId(entry.id, email);
      replacements.push([entry.id, out.id]);
    }
    if (typeof entry.calendar === 'string') {
      out.calendar = prefixId(entry.calendar, email);
      replacements.push([entry.calendar, out.calendar]);
    }
    return out;
  };
  const out = { ...structured };
  if (Array.isArray(structured.calendars)) {
    out.calendars = structured.calendars.map(tagEntry);
  }
  if (Array.isArray(structured.events)) {
    out.events = structured.events.map(tagEntry);
  }
  if (typeof structured.event === 'object' && structured.event !== null) {
    out.event = tagEntry(structured.event);
  }
  return { structured: out, replacements };
}

function applyReplacements(text, replacements) {
  let out = text;
  for (const [bare, prefixed] of replacements) {
    out = out.split(`"${bare}"`).join(`"${prefixed}"`);
  }
  return out;
}

/** One gateway's tool result with its ids tagged, or null when the answer carries no result. */
function taggedToolResult(message, email) {
  const result = message?.result;
  if (typeof result !== 'object' || result === null || result.isError === true) {
    return message;
  }
  const { structured, replacements } = tagResult(result.structuredContent, email);
  const out = { ...message, result: { ...result, structuredContent: structured } };
  if (Array.isArray(result.content)) {
    out.result.content = result.content.map(part =>
      part?.type === 'text' && typeof part.text === 'string'
        ? { ...part, text: applyReplacements(part.text, replacements) }
        : part,
    );
  }
  return out;
}

/** Merges the per-account answers of a fanned-out read into one answer. */
function mergedToolResult(messages, tool) {
  const parts = messages.filter(
    message => typeof message?.result === 'object' && message.result !== null && message.result.isError !== true,
  );
  if (parts.length === 0) {
    return messages[0];
  }
  const key = tool === 'list_calendars' ? 'calendars' : 'events';
  const merged = { ...parts[0].result.structuredContent };
  const entries = [];
  const notes = [];
  let count = 0;
  let withheld = 0;
  let truncated = false;
  for (const part of parts) {
    const structured = part.result.structuredContent;
    if (Array.isArray(structured?.[key])) {
      entries.push(...structured[key]);
    }
    if (typeof structured?.count === 'number') {
      count += structured.count;
    }
    if (typeof structured?.withheld === 'number') {
      withheld += structured.withheld;
    }
    if (Array.isArray(structured?.notes)) {
      notes.push(...structured.notes);
    }
    if (structured?.truncated !== undefined) {
      truncated = true;
    }
  }
  merged[key] = entries;
  merged.count = count;
  if (tool === 'list_calendars') {
    merged.withheld = withheld;
  }
  if (parts.length < messages.length) {
    // At least one account answered and at least one did not: say so, so the merged answer is
    // never mistaken for the whole picture. When no account answered, the caller returns the
    // first error reply instead and this merge never runs.
    notes.push('One account did not answer, so this answer may not be complete.');
  }
  if (notes.length > 0) {
    merged.notes = notes;
  }
  if (truncated) {
    delete merged.truncated;
    merged.notes = [
      ...(merged.notes ?? []),
      'Some answers were cut short. Ask for one account or a shorter time to see the rest.',
    ];
  }
  return {
    jsonrpc: '2.0',
    id: messages[0].id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(merged, null, 2) }],
      structuredContent: merged,
    },
  };
}

function errorMessage(id, text) {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }], isError: true },
  };
}

/**
 * Builds the multiplexer. `targets` reads the current gateways, default first, as
 * [{email, url}] with each url the gateway's MCP address. `fetchImpl` is injectable for tests.
 */
export function createMux({ targets, fetchImpl = fetch }) {
  async function callGateway(target, message) {
    const response = await fetchImpl(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(message),
    });
    const text = await response.text();
    const dataLine = text.split('\n').find(line => line.startsWith('data: '));
    return JSON.parse(dataLine === undefined ? text : dataLine.slice('data: '.length));
  }

  async function route(message) {
    const current = targets();
    if (current.length === 0) {
      return errorMessage(message.id, 'No calendar account is connected.');
    }
    const emails = current.map(target => target.email);
    const byEmail = new Map(current.map(target => [target.email, target]));
    if (message.method === 'tools/list') {
      const reply = await callGateway(current[0], message);
      const tools = reply?.result?.tools;
      if (Array.isArray(tools)) {
        reply.result.tools = tools.map(tool => ({
          ...tool,
          inputSchema:
            typeof tool.inputSchema === 'object' && tool.inputSchema !== null
              ? {
                  ...tool.inputSchema,
                  properties: { ...(tool.inputSchema.properties ?? {}), account: ACCOUNT_PROPERTY },
                }
              : tool.inputSchema,
        }));
      }
      return reply;
    }
    if (message.method !== 'tools/call') {
      return callGateway(current[0], message);
    }
    const name = message.params?.name;
    const args =
      typeof message.params?.arguments === 'object' && message.params?.arguments !== null
        ? message.params.arguments
        : {};
    if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name)) {
      // Not one of the eight: the gateway's own allow list gives the refusal.
      return callGateway(current[0], message);
    }
    const named = namedAccounts(args, emails);
    if (named.size > 1) {
      return errorMessage(
        message.id,
        'That call names two different accounts, so nothing was done. Use the ids of one account, or name one account.',
      );
    }
    // The host may scope a spanning read to the accounts a persona may use. The scope is honoured
    // here and never forwarded: no tool server knows it exists.
    const limit = Array.isArray(args.limit_accounts)
      ? args.limit_accounts.filter(entry => typeof entry === 'string' && byEmail.has(entry))
      : null;
    if (limit !== null && named.size === 1 && !limit.includes([...named][0])) {
      return errorMessage(
        message.id,
        'That call names an account outside the accounts it may use, so nothing was done.',
      );
    }
    const inScope = limit === null ? current : current.filter(target => limit.includes(target.email));
    if (inScope.length === 0) {
      return errorMessage(message.id, 'No calendar account is connected.');
    }
    const namedOne = named.size === 1 ? [...named][0] : null;
    if (namedOne !== null && !byEmail.has(namedOne)) {
      return errorMessage(
        message.id,
        `There is no calendar account named ${namedOne}. The accounts are ${emails.join(', ')}.`,
      );
    }
    const forward = target => ({
      ...message,
      params: { ...message.params, arguments: argumentsForTarget(args, target.email) },
    });
    if (WRITE_TOOLS.has(name)) {
      if (namedOne === null) {
        return errorMessage(
          message.id,
          'That change does not name a calendar from any connected account, so nothing was changed. ' +
            'List the calendars first: their ids name the account they belong to.',
        );
      }
      const target = byEmail.get(namedOne);
      return taggedToolResult(await callGateway(target, forward(target)), namedOne);
    }
    // Reads. A read settled on one account goes only there; any other read spans every account.
    const settles =
      namedOne !== null &&
      (name === 'get_event' ||
        typeof args.account === 'string' ||
        (Array.isArray(args.calendars) && args.calendars.length > 0) ||
        name === 'list_calendars');
    if (settles && namedOne !== null) {
      const target = byEmail.get(namedOne);
      return taggedToolResult(await callGateway(target, forward(target)), namedOne);
    }
    if (name === 'get_event') {
      return errorMessage(
        message.id,
        'That event id does not name an account, so nothing was read. Use an id from a calendar answer: its ids name the account they belong to.',
      );
    }
    const replies = [];
    for (const target of inScope) {
      const reply = await callGateway(target, forward(target));
      replies.push(taggedToolResult(reply, target.email));
    }
    const usable = replies.filter(reply => reply?.result?.isError !== true);
    if (usable.length === 0) {
      return replies[0];
    }
    return mergedToolResult(replies, name);
  }

  return createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'too_large' }));
          return;
        }
        chunks.push(chunk);
      }
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
        return;
      }
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }));
        return;
      }
      if (message.id === undefined) {
        // A notification: hand it to every gateway and answer with no body, as the protocol expects.
        const current = targets();
        for (const target of current) {
          await callGateway(target, message).catch(() => undefined);
        }
        res.writeHead(202);
        res.end();
        return;
      }
      const reply = await route(message);
      const data = JSON.stringify({ ...reply, id: message.id });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
      res.end(data);
    } catch {
      // Fixed words only: an upstream answer can carry calendar text, and a failure here is the mux's.
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'calendar multiplexer failed' } }),
        );
      } catch {
        // The connection is already gone.
      }
    }
  });
}
