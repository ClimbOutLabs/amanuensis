/**
 * Inert Streamable HTTP MCP connector used by the approval-flow and
 * memory-flow tests.
 *
 * Four tools cover the annotation shapes the approval policy branches on:
 * `readOnlyHint: true` (never gated by default; `inert_read` is force-gated by
 * the test agent spec's `require_approval_for_tools` so the chat-scope grant
 * path — only offered for read-only, non-open-world tools — can be exercised
 * against a real pending approval), `readOnlyHint: false` (gated as `@write`,
 * and ineligible for a chat-scope grant), and no annotations at all (gated by
 * default via `@unclassified` — silence is never read as permission). None of
 * them reach the network or the filesystem — the only observable effect is an
 * in-memory invocation counter, so "did the gate let this run" is answerable
 * without side effects.
 *
 * Two more tools, `ask_memory` and `search_memory`, are shaped after LKOS's
 * real retrieval contract (see `ops/memory/DESIGN.md`): both are annotated
 * `readOnlyHint: true, openWorldHint: false` so they escape the
 * `@unclassified` default the same way `inert_read` does. Their result mode —
 * a populated result set, or LKOS's distinguishable empty (empty `claims` plus
 * empty `context`, `isError: false`, never an error and never invented prose)
 * — is controlled per test via {@link InertMcpServer.setAskMemoryMode} /
 * {@link InertMcpServer.setSearchMemoryMode}. `stop`/`start` take the whole
 * connector offline and bring it back on the same port (a refused connection,
 * simulating the server process being down), distinct from `sever`/`restore`
 * (which keeps listening but answers every request with a 503).
 *
 * The same server doubles as a Hindsight-shaped memory provider: `memoryProviderUrl`
 * has the `{apiBase}/mcp/{bank}` shape the memory-provider setup requires, and the fixture answers the
 * REST recall route behind it, so the setup's connection check passes and a connector registered
 * through the real setup flow is first-party.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';

export const INERT_SERVER_NAME = 'inert';
export const INERT_ECHO_TOOL = 'inert_echo';
export const INERT_READ_TOOL = 'inert_read';
export const INERT_WRITE_TOOL = 'inert_write';
export const INERT_UNANNOTATED_TOOL = 'inert_unannotated';
export const INERT_ASK_MEMORY_TOOL = 'ask_memory';
export const INERT_SEARCH_MEMORY_TOOL = 'search_memory';
/** Opt-in (`startInertMcpServer({ webSearch: true })`), so the default tool list stays unchanged. */
export const INERT_WEB_SEARCH_TOOL = 'web_search';
/** Opt-in (`startInertMcpServer({ searchProvider: true })`) with `web_search` in the search provider's shape. */
export const INERT_WEB_FETCH_TOOL = 'web_fetch';

/** Bank in `memoryProviderUrl`; the fixture answers a recall for any bank, so a URL can move between them. */
const INERT_MEMORY_BANK = 'aman';
const MEMORY_RECALL_PATH = /^\/v1\/default\/banks\/[^/]+\/memories\/recall$/;

/**
 * LKOS's `AskMemoryResponse` shape: empty means empty context plus empty claim groups.
 * The index signature is what makes this assignable to the MCP SDK's `structuredContent`
 * (`{ [x: string]: unknown }`) without an assertion escape.
 */
export interface MemoryToolResult {
  claims: { statement: string; groups: string[] }[];
  context: string;
  [key: string]: unknown;
}

/** The distinguishable empty: never an error, never invented prose filler. */
export const EMPTY_MEMORY_RESULT: MemoryToolResult = { claims: [], context: '' };

/** Which shape `ask_memory` / `search_memory` answer with, until changed again. */
export type MemoryToolMode = 'result' | 'empty';

/**
 * The non-empty shape `ask_memory` / `search_memory` answer with in `'result'` mode.
 * Exported so tests can assert the exact value without duplicating the fixture's wording.
 */
export function populatedMemoryResult(query: string): MemoryToolResult {
  return {
    claims: [{ statement: `Recalled note matching "${query}".`, groups: ['inert-memory'] }],
    context: `One matching recollection for "${query}".`,
  };
}

/** One armed pause over the write tool: the test waits for `entered`, then calls `release`. */
export interface WriteHold {
  /** Resolves once the write tool has been entered and is parked. */
  entered: Promise<void>;
  release: () => void;
}

/** A redirect for `InertMcpServer.redirectAllTo`. */
export interface InertRedirect {
  /** Origin the redirect points at. The request's own path is appended, so that origin serves the same route. */
  to: string;
  status: 301 | 302 | 303 | 307 | 308;
}

export interface InertMcpServer {
  /** Streamable HTTP endpoint to register as the connector `url`. Stable across `stop`/`start`. */
  url: string;
  /** The same endpoint as a single-bank memory provider URL; the setup's recall check is answered. */
  memoryProviderUrl: string;
  /** Origin of {@link InertMcpServer.url}: what an operator lists in `FIRST_PARTY_MCP_ORIGINS` to vouch for this server. */
  origin: string;
  /** Times the gated write tool actually started executing. */
  writeInvocations: () => number;
  echoInvocations: () => number;
  readInvocations: () => number;
  unannotatedInvocations: () => number;
  askMemoryInvocations: () => number;
  searchMemoryInvocations: () => number;
  webSearchInvocations: () => number;
  webFetchInvocations: () => number;
  /**
   * Resets every invocation counter, the request count and the last `Authorization` value, drops
   * any redirect, and returns both memory tools to `'result'` mode.
   */
  resetInvocations: () => void;
  /**
   * While set, every request is answered with this redirect instead of its normal reply: an
   * origin that points somewhere else. Pass `undefined` to serve normally again.
   */
  redirectAllTo: (redirect: InertRedirect | undefined) => void;
  /** HTTP requests received since the last reset, whatever they were answered with. */
  requestsSeen: () => number;
  /**
   * While set, the search provider's `web_search` answers each query with these page links, as JSON results
   * that each carry their own `url` like a real provider's, instead of its invented line. `undefined` restores it.
   */
  setSearchResults: (results: ((query: string) => string[]) | undefined) => void;
  /** Parks the next write invocation so a turn can be cancelled mid-execution. */
  holdNextWrite: () => WriteHold;
  /** Refuses every request until {@link InertMcpServer.restore}, severing an in-flight submission. */
  sever: () => void;
  restore: () => void;
  /** Sets the result shape the next (and every subsequent) `ask_memory` call answers with. */
  setAskMemoryMode: (mode: MemoryToolMode) => void;
  /** Sets the result shape the next (and every subsequent) `search_memory` call answers with. */
  setSearchMemoryMode: (mode: MemoryToolMode) => void;
  /**
   * The `Authorization` value of the most recent HTTP request that carried one since the last
   * reset. A request without it never clears it: an earlier session's client can still retry its
   * event stream against a restarted connector, and that stray request carries no credential.
   */
  lastAuthorizationHeader: () => string | undefined;
  /**
   * Closes the listening socket and every open MCP session, simulating the
   * server process going down: a new request gets a refused connection, not
   * a response. Distinct from {@link InertMcpServer.sever}, which keeps
   * listening. Idempotent.
   */
  stop: () => Promise<void>;
  /** Re-listens on the same port {@link InertMcpServer.stop} released. Idempotent. */
  start: () => Promise<void>;
  close: () => Promise<void>;
}

interface Counters {
  echo: number;
  read: number;
  write: number;
  unannotated: number;
  askMemory: number;
  searchMemory: number;
  webSearch: number;
  webFetch: number;
}

interface SearchResults {
  current: ((query: string) => string[]) | undefined;
}

interface MemoryModes {
  ask: MemoryToolMode;
  search: MemoryToolMode;
}

/** Server-side half of a {@link WriteHold}: the tool signals entry, then parks on `released`. */
interface WriteGate {
  markEntered: () => void;
  released: Promise<void>;
}

function readRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', error => {
      reject(new Error('inert MCP fixture could not read the request body', { cause: error }));
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('inert MCP fixture received a non-JSON body', { cause: error }));
      }
    });
  });
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/** A structured, never-an-error result: `content` is the spec-required (possibly empty) array. */
function memoryResult(structuredContent: MemoryToolResult) {
  return { content: [], structuredContent, isError: false };
}

/**
 * A fresh `McpServer` per session keeps tool state out of the transport, while the
 * counters, memory modes, and hold queue stay on the enclosing fixture so assertions
 * see every session's invocations.
 */
function buildMcpServer({
  counters,
  gates,
  memoryModes,
  searchResults,
  webSearch,
  searchProvider,
}: {
  counters: Counters;
  gates: WriteGate[];
  memoryModes: MemoryModes;
  searchResults: SearchResults;
  webSearch: boolean;
  searchProvider: boolean;
}): McpServer {
  const server = new McpServer({ name: 'inert-connector', version: '0.0.0' });

  server.registerTool(
    INERT_ECHO_TOOL,
    {
      description: 'Returns its input unchanged.',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ text }) => {
      counters.echo += 1;
      return textResult(text);
    },
  );

  server.registerTool(
    INERT_READ_TOOL,
    {
      description:
        'Returns its input unchanged. Read-only and non-open-world, but the test agent spec ' +
        'force-gates it via require_approval_for_tools so a pending approval exists to grant.',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ text }) => {
      counters.read += 1;
      return textResult(text);
    },
  );

  server.registerTool(
    INERT_WRITE_TOOL,
    {
      description: 'Records a value. Annotated as a write so the approval gate covers it.',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: false },
    },
    async ({ text }) => {
      // Counted on entry: the question these tests ask is whether the gate let
      // execution start at all, not whether it ran to completion.
      counters.write += 1;
      const gate = gates.shift();
      if (gate) {
        gate.markEntered();
        await gate.released;
      }
      return textResult(`wrote ${text}`);
    },
  );

  server.registerTool(
    INERT_UNANNOTATED_TOOL,
    {
      description: 'Carries no annotations, so it matches `@unclassified` and is gated by default.',
      inputSchema: { text: z.string() },
    },
    ({ text }) => {
      counters.unannotated += 1;
      return textResult(`unannotated ${text}`);
    },
  );

  server.registerTool(
    INERT_ASK_MEMORY_TOOL,
    {
      description:
        'Answers a question from the memory archive. Read-only and non-open-world, modeled on ' +
        "LKOS's ask_memory. Empty means an empty AskMemoryResponse, never an error.",
      inputSchema: { question: z.string(), limit: z.number().int().positive().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ question }) => {
      counters.askMemory += 1;
      return memoryResult(memoryModes.ask === 'empty' ? EMPTY_MEMORY_RESULT : populatedMemoryResult(question));
    },
  );

  server.registerTool(
    INERT_SEARCH_MEMORY_TOOL,
    {
      description:
        'Searches the memory archive by text. Read-only and non-open-world, modeled on ' +
        "LKOS's search_memory. Empty means an empty result, never an error.",
      inputSchema: { text: z.string(), limit: z.number().int().positive().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ text }) => {
      counters.searchMemory += 1;
      return memoryResult(memoryModes.search === 'empty' ? EMPTY_MEMORY_RESULT : populatedMemoryResult(text));
    },
  );

  if (webSearch) {
    server.registerTool(
      INERT_WEB_SEARCH_TOOL,
      {
        description: 'Pretends to search the open web. Never reaches the network.',
        inputSchema: { query: z.string() },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      ({ query }) => {
        counters.webSearch += 1;
        return textResult(`no results for ${query}`);
      },
    );
  }

  if (searchProvider) {
    server.registerTool(
      INERT_WEB_SEARCH_TOOL,
      {
        description: 'Pretends to search the open web for each query. Never reaches the network.',
        inputSchema: {
          objective: z.string(),
          search_queries: z.array(z.string()),
          session_id: z.string().optional(),
          model_name: z.string().optional(),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      ({ search_queries }) => {
        counters.webSearch += 1;
        const n = counters.webSearch;
        const results = searchResults.current;
        if (results !== undefined) {
          // A real provider's shape: each result carries its own `url`, which a later page read may name.
          return textResult(
            JSON.stringify({
              results: search_queries.flatMap(query =>
                results(query).map(url => ({ url, title: `Result for ${query}`, excerpts: [`About ${query}.`] })),
              ),
            }),
          );
        }
        return textResult(
          search_queries
            .map(query => `Result for ${query}: https://source-${String(n)}.example.org/article`)
            .join('\n'),
        );
      },
    );
    server.registerTool(
      INERT_WEB_FETCH_TOOL,
      {
        description: 'Pretends to read web pages. Never reaches the network.',
        inputSchema: {
          urls: z.array(z.string()),
          objective: z.string().optional(),
          session_id: z.string().optional(),
          model_name: z.string().optional(),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      ({ urls }) => {
        counters.webFetch += 1;
        return textResult(urls.map(url => `${url}: a short page about Lantern Row.`).join('\n'));
      },
    );
  }

  return server;
}

/**
 * `StreamableHTTPServerTransport` declares its `onclose`/`onerror`/`onmessage`
 * accessors as reading back `X | undefined` (there may be no handler installed
 * yet), but `Transport`'s matching properties are plain optionals that, under
 * this repo's `exactOptionalPropertyTypes`, may never read back an explicit
 * `undefined`. Wrap the concrete transport in an object that always reads back
 * a real callback — a no-op before a handler exists — while every write still
 * proxies straight through to the same transport instance that `handleRequest`
 * drives, so runtime wiring (in particular `McpServer.connect`'s own
 * onclose/onerror/onmessage chaining) is unchanged.
 *
 * `sessionId` is deliberately not forwarded: it is undefined at the moment
 * `connect` runs (the session is assigned by the initialize request that
 * follows), and nothing in this fixture's tools or `McpServer` construction
 * (no task store) ever reads it back afterwards. Code that needs the live
 * session id already has direct access to `transport` via `onsessioninitialized`.
 */
export function asTransport(transport: StreamableHTTPServerTransport): Transport {
  return {
    start: () => transport.start(),
    send: (message, options) => transport.send(message, options),
    close: () => transport.close(),
    get onclose(): () => void {
      const handler = transport.onclose;
      return handler ?? (() => undefined);
    },
    set onclose(handler: (() => void) | undefined) {
      transport.onclose = handler;
    },
    get onerror(): (error: Error) => void {
      const handler = transport.onerror;
      return handler ?? (() => undefined);
    },
    set onerror(handler: ((error: Error) => void) | undefined) {
      transport.onerror = handler;
    },
    get onmessage() {
      const handler = transport.onmessage;
      return handler ?? (() => undefined);
    },
    set onmessage(handler) {
      transport.onmessage = handler;
    },
  };
}

export async function startInertMcpServer(options?: {
  webSearch?: boolean;
  /** Adds `web_search` and `web_fetch` in the search provider's argument shape; excludes `webSearch`. */
  searchProvider?: boolean;
}): Promise<InertMcpServer> {
  const webSearch = options?.webSearch === true;
  const searchProvider = options?.searchProvider === true;
  if (webSearch && searchProvider) {
    throw new Error('inert MCP fixture offers one web_search: pick webSearch or searchProvider');
  }
  const counters: Counters = {
    echo: 0,
    read: 0,
    write: 0,
    unannotated: 0,
    askMemory: 0,
    searchMemory: 0,
    webSearch: 0,
    webFetch: 0,
  };
  const memoryModes: MemoryModes = { ask: 'result', search: 'result' };
  const searchResults: SearchResults = { current: undefined };
  const gates: WriteGate[] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let severed = false;
  let redirect: InertRedirect | undefined;
  let requestCount = 0;
  let lastAuthorizationHeader: string | undefined;
  let running = false;
  let boundPort: number | undefined;
  let httpServer: Server | undefined;

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string') {
      lastAuthorizationHeader = authHeader;
    }

    requestCount += 1;
    if (redirect !== undefined) {
      req.resume();
      res.writeHead(redirect.status, { location: `${redirect.to}${req.url ?? '/'}` });
      res.end();
      return;
    }
    if (severed) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'inert MCP fixture is severed' }));
      return;
    }
    if (req.method === 'POST' && req.url !== undefined && MEMORY_RECALL_PATH.test(req.url)) {
      // The memory-provider setup check: an authenticated, empty recall.
      req.resume();
      const body = JSON.stringify({ results: [], entities: {} });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
      res.end(body);
      return;
    }
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    const existing = sessionId === undefined ? undefined : transports.get(sessionId);
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }

    const body = await readRequestBody(req);
    if (!isInitializeRequest(body)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'inert MCP fixture expects an initialize request to open a session' }));
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
      const id = transport.sessionId;
      if (id !== undefined) {
        transports.delete(id);
      }
    };
    await buildMcpServer({ counters, gates, memoryModes, searchResults, webSearch, searchProvider }).connect(
      asTransport(transport),
    );
    await transport.handleRequest(req, res, body);
  }

  function makeHttpServer(): Server {
    return createServer((req, res) => {
      // No keep-alive: `stop()` then `start()` on the same port can run with no I/O turn in
      // between, so the client's HTTP pool may not have seen the old socket close yet and
      // would reuse it for the next request ("fetch failed"). A fresh connection per request
      // makes a restart indistinguishable from a server that was never down.
      res.setHeader('connection', 'close');
      void dispatch(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'inert MCP fixture failed' }));
      });
    });
  }

  /** Listens `server` on `port` (0 for an OS-assigned port) and returns the bound port. */
  async function listen(server: Server, port: number): Promise<number> {
    await new Promise<void>(resolve => {
      server.listen(port, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('inert MCP fixture did not bind a TCP port');
    }
    return address.port;
  }

  /** Closes every open MCP session and the listening socket. Idempotent. */
  async function stopServer(): Promise<void> {
    if (!running || httpServer === undefined) {
      return;
    }
    running = false;
    for (const transport of transports.values()) {
      await transport.close();
    }
    transports.clear();
    const server = httpServer;
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(new Error('inert MCP fixture failed to close', { cause: error }));
          return;
        }
        resolve();
      });
    });
  }

  httpServer = makeHttpServer();
  boundPort = await listen(httpServer, 0);
  running = true;
  const origin = `http://127.0.0.1:${String(boundPort)}`;
  const url = `${origin}/mcp`;

  return {
    url,
    origin,
    memoryProviderUrl: `${url}/${INERT_MEMORY_BANK}`,
    writeInvocations: () => counters.write,
    echoInvocations: () => counters.echo,
    readInvocations: () => counters.read,
    unannotatedInvocations: () => counters.unannotated,
    askMemoryInvocations: () => counters.askMemory,
    searchMemoryInvocations: () => counters.searchMemory,
    webSearchInvocations: () => counters.webSearch,
    webFetchInvocations: () => counters.webFetch,
    resetInvocations: () => {
      counters.echo = 0;
      counters.read = 0;
      counters.write = 0;
      counters.unannotated = 0;
      counters.askMemory = 0;
      counters.searchMemory = 0;
      counters.webSearch = 0;
      counters.webFetch = 0;
      memoryModes.ask = 'result';
      memoryModes.search = 'result';
      lastAuthorizationHeader = undefined;
      requestCount = 0;
      redirect = undefined;
    },
    redirectAllTo: next => {
      redirect = next;
    },
    requestsSeen: () => requestCount,
    setSearchResults: results => {
      searchResults.current = results;
    },
    holdNextWrite: () => {
      const entered: PromiseWithResolvers<void> = Promise.withResolvers();
      const released: PromiseWithResolvers<void> = Promise.withResolvers();
      gates.push({
        markEntered: () => {
          entered.resolve();
        },
        released: released.promise,
      });
      return {
        entered: entered.promise,
        release: () => {
          released.resolve();
        },
      };
    },
    sever: () => {
      severed = true;
    },
    restore: () => {
      severed = false;
    },
    setAskMemoryMode: mode => {
      memoryModes.ask = mode;
    },
    setSearchMemoryMode: mode => {
      memoryModes.search = mode;
    },
    lastAuthorizationHeader: () => lastAuthorizationHeader,
    stop: stopServer,
    start: async () => {
      if (running || boundPort === undefined) {
        return;
      }
      httpServer = makeHttpServer();
      boundPort = await listen(httpServer, boundPort);
      running = true;
    },
    close: async () => {
      await stopServer();
    },
  };
}
