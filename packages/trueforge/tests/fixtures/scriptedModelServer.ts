/**
 * OpenAI-compatible chat-completions endpoint that answers from the prompt instead
 * of a model, so the approval tests exercise the real server path (VercelAILLM →
 * HTTP → tool call → approval gate) with a deterministic tool-calling "model".
 *
 * Contract: a user message containing `run:<tool>` produces a tool call against
 * the advertised tool whose name contains `<tool>`; once its scripted sequence
 * is complete, the turn is closed with plain text. `run:call_tool` reaches a
 * deferred connector's tool: it targets `inert` unless the same message adds
 * `server:<name>`. A `text:<value>` in the same message sets the `text` argument of
 * a tool that takes one (default `inert`). A tool the request does not send is reached the way a
 * model would: it loads the tool's bundle with `load_bundle` first.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { FIND_PLACES_QUERY, GARDEN_URL, HARBOUR_ADDRESS, HARBOUR_URL, scriptedPlaces } from './groundedFinderFixtures';

export const RUN_DIRECTIVE_PREFIX = 'run:';
export const SERVER_DIRECTIVE_PREFIX = 'server:';
export const TEXT_DIRECTIVE_PREFIX = 'text:';
const DEFAULT_TEXT_ARGUMENT = 'inert';
const DEFAULT_CALL_TOOL_SERVER = 'inert';
export const FINAL_TEXT = 'inert connector work is finished.';
/** Answers with the text of the last tool result instead of FINAL_TEXT, so a test can read what the tool returned. */
export const QUOTE_TOOL_RESULT_DIRECTIVE = 'quote_tool_result';
export const VERIFY_THEN_COMMIT_DIRECTIVE = 'verify_then_commit';
export const COMMIT_ONLY_DIRECTIVE = 'commit_only';
/** Calls the write tool, then `web_search` for `WEB_SEARCH_QUERY`, then answers. */
export const WRITE_THEN_SEARCH_DIRECTIVE = 'write_then_search';
export const WEB_SEARCH_QUERY = 'Lantern Row bakery';
/** Searches with Tavily, reads two result pages, then pins the places it found, then answers. */
export const FIND_PLACES_DIRECTIVE = 'find_places';
/**
 * Lists the inbox, then runs one web search for the text after `search:` (to the end of the line),
 * then maps the address the inbox names, then answers. Built for scheduled runs, which have no one to ask.
 */
export const BRIEF_DIRECTIVE = 'brief';
export const SEARCH_DIRECTIVE_PREFIX = 'search:';
/** Calls the unannotated connector tool three times in one model message, then answers. */
export const THREE_AT_ONCE_DIRECTIVE = 'three_at_once';
export const THREE_AT_ONCE_TEXTS = ['first', 'second', 'third'] as const;
/**
 * A question carrying this marker makes the knowledge relevance judge keep no
 * passage, so a library lookup for it is a near-miss.
 */
export const JUDGE_REJECT_MARKER = 'judge_reject';
const RELEVANCE_JUDGE_TAG = '<knowledge-relevance-judge';

export interface ScriptedModelServer {
  /** Value for a `custom` model provider `base_url`. */
  baseUrl: string;
  /** Chat-completion requests served so far, oldest first. */
  requests: () => readonly ChatCompletionRequest[];
  close: () => Promise<void>;
}

interface ChatMessage {
  role: string;
  content?: unknown;
}

interface AdvertisedTool {
  function?: { name?: unknown };
}

export interface ChatCompletionRequest {
  /** Model id the caller asked for — the only proof of which model actually ran. */
  model: string;
  messages: ChatMessage[];
  tools: AdvertisedTool[];
  stream: boolean;
  /** Provider-specific control proving bounded host calls do not emit reasoning. */
  chatTemplateKwargs: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const messages: ChatMessage[] = [];
  for (const entry of value) {
    if (isRecord(entry) && typeof entry['role'] === 'string') {
      messages.push({ role: entry['role'], content: entry['content'] });
    }
  }
  return messages;
}

function toAdvertisedTools(value: unknown): AdvertisedTool[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const tools: AdvertisedTool[] = [];
  for (const entry of value) {
    if (isRecord(entry) && isRecord(entry['function'])) {
      tools.push({ function: { name: entry['function']['name'] } });
    }
  }
  return tools;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && typeof part['text'] === 'string') {
      parts.push(part['text']);
    }
  }
  return parts.join(' ');
}

/** A text part that is one whole host-written block, such as `<aman-memory>…</aman-memory>`. */
const HOST_BLOCK = /^\s*<([a-z][a-z-]*)>[\s\S]*<\/\1>\s*$/;

/**
 * What the person wrote in a user message. The host puts per-reply context (the reply block,
 * recalled memory) into the same message as labelled blocks; like a real model, the script
 * reads directives only from the person's own words, never from recalled chat titles.
 */
function personText(content: unknown): string {
  const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content : [];
  const own: string[] = [];
  for (const part of parts) {
    const text = typeof part === 'string' ? part : isRecord(part) ? part['text'] : undefined;
    if (typeof text === 'string' && !HOST_BLOCK.test(text)) {
      own.push(text);
    }
  }
  return own.join(' ');
}

/** The advertised name for a directive, matched by substring so harness renaming still resolves. */
function resolveToolName({ directive, tools }: { directive: string; tools: AdvertisedTool[] }): string | undefined {
  for (const tool of tools) {
    const name = tool.function?.name;
    if (typeof name === 'string' && name.includes(directive)) {
      return name;
    }
  }
  return undefined;
}

/**
 * The bundle a model would load for a tool it cannot see, read from the tool's name as a model reads
 * the bundle index. A connector's other tools ride with the search connector, so `inert` is web.
 */
const BUNDLE_FOR_TOOL: [match: string, bundle: string][] = [
  ['tavily', 'web'],
  ['web_search', 'web'],
  ['inert', 'web'],
  ['render_', 'maps'],
  ['list_inbox', 'google'],
  ['usage_summary', 'extras'],
  ['exec', 'sandbox'],
];

/** A `load_bundle` result, which answers the load, not the scripted step. */
function isBundleLoadResult(message: ChatMessage): boolean {
  return (
    message.role === 'tool' &&
    /\b[a-z_]+ is (already )?loaded\. Its (tools|guidance)/.test(messageText(message.content))
  );
}

/** The bundle to load before calling `match`, when the tool is not sent and its bundle is not loaded yet. */
function bundleToLoad({ match, request }: { match: string; request: ChatCompletionRequest }): string | undefined {
  if (resolveToolName({ directive: 'load_bundle', tools: request.tools }) === undefined) {
    return undefined;
  }
  const bundle = BUNDLE_FOR_TOOL.find(([part]) => match.includes(part))?.[1];
  const system = messageText(request.messages.find(message => message.role === 'system')?.content);
  const offered = new RegExp(`^- ${bundle ?? ''}: .*$`, 'm').exec(system)?.[0];
  return bundle === undefined || offered === undefined || offered.endsWith('(loaded)') ? undefined : bundle;
}

/** The text of the last tool result in the conversation, if a tool has answered. */
function lastToolResultText(messages: ChatMessage[]): string | undefined {
  const results = messages.filter(message => message.role === 'tool');
  const last = results[results.length - 1];
  return last === undefined ? undefined : messageText(last.content);
}

/** The `run:<tool>` directive still awaiting a tool result, or undefined when none is open. */
function pendingDirective(messages: ChatMessage[]): string | undefined {
  let directive: string | undefined;
  for (const message of messages) {
    if (isBundleLoadResult(message)) {
      continue;
    }
    if (message.role === 'tool') {
      directive = undefined;
      continue;
    }
    if (message.role !== 'user') {
      continue;
    }
    const text = personText(message.content);
    const match = new RegExp(`${RUN_DIRECTIVE_PREFIX}([A-Za-z0-9_-]+)`).exec(text);
    directive = match?.[1];
  }
  return directive;
}

function readRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', error => {
      reject(new Error('scripted model fixture could not read the request body', { cause: error }));
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch (error) {
        reject(new Error('scripted model fixture received a non-JSON body', { cause: error }));
      }
    });
  });
}

/**
 * Every scripted tool call has always taken a single `text` field — until `ask_memory`,
 * whose real (and fixture) input schema is `question`/`limit` instead. Naming the
 * argument by substring keeps every other directive (including `search_memory`, which
 * still takes `text`) on its existing hardcoded call.
 *
 * `call_tool` is the one TF-managed exception: it is the deferred-tool-loading escape
 * hatch (`DeferredTool`, `packages/trueforge-core/src/core/runtime/DeferredTool.ts`) a
 * turn always advertises, and `run:call_tool` drives it against `ask_memory` on the
 * `inert` connector — the only way to reach a non-preloaded server's tool without
 * simulating the full list_tools/get_tool_info discovery round trip.
 */
function argumentsJsonForTool({
  name,
  callToolServer,
  text,
}: {
  name: string;
  callToolServer: string;
  text: string;
}): string {
  if (name === 'call_tool') {
    return JSON.stringify({ mcp_server: callToolServer, tool_name: 'ask_memory', input: { question: 'inert' } });
  }
  if (name === 'usage_summary') {
    return '{}';
  }
  return name.includes('ask_memory') ? '{"question":"inert"}' : JSON.stringify({ text });
}

/** The `text:<value>` of the latest user message that names one, else the default. */
function textArgument(messages: ChatMessage[]): string {
  let text = DEFAULT_TEXT_ARGUMENT;
  for (const message of messages) {
    if (message.role === 'user') {
      text =
        new RegExp(`${TEXT_DIRECTIVE_PREFIX}(\\S+)`).exec(personText(message.content))?.[1] ?? DEFAULT_TEXT_ARGUMENT;
    }
  }
  return text;
}

/** The connector the latest `run:` directive's `call_tool` targets: its `server:<name>`, else `inert`. */
function callToolServer(messages: ChatMessage[]): string {
  let server = DEFAULT_CALL_TOOL_SERVER;
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const text = personText(message.content);
    if (new RegExp(`${RUN_DIRECTIVE_PREFIX}[A-Za-z0-9_-]+`).test(text)) {
      server = new RegExp(`${SERVER_DIRECTIVE_PREFIX}([A-Za-z0-9_-]+)`).exec(text)?.[1] ?? DEFAULT_CALL_TOOL_SERVER;
    }
  }
  return server;
}

/** The text after the latest `search:` directive, up to the end of its line; empty when none is given. */
function searchDirectiveText(messages: ChatMessage[]): string {
  let text = '';
  for (const message of messages) {
    if (message.role === 'user') {
      text = new RegExp(`${SEARCH_DIRECTIVE_PREFIX}([^\\n]+)`).exec(personText(message.content))?.[1]?.trim() ?? '';
    }
  }
  return text;
}

function briefSteps(messages: ChatMessage[]): { match: string; argumentsJson: string }[] {
  return [
    { match: 'list_inbox_threads', argumentsJson: JSON.stringify({ query: 'in:inbox' }) },
    { match: 'tavily_search', argumentsJson: JSON.stringify({ query: searchDirectiveText(messages) }) },
    { match: 'render_map', argumentsJson: JSON.stringify({ place_name: HARBOUR_ADDRESS }) },
  ];
}

function sandboxArgumentsJson(purpose: 'verify' | 'commit'): string {
  return JSON.stringify({
    intent: purpose === 'verify' ? 'Verify the repository before committing' : 'Commit the verified repository state',
    purpose,
    command: purpose === 'verify' ? 'pnpm verify' : 'git commit -m "verified change"',
    cwd: '/repo',
  });
}

function directiveProgress(messages: ChatMessage[]): { directive: string | undefined; toolResults: number } {
  let directive: string | undefined;
  let toolResults = 0;
  for (const message of messages) {
    if (message.role === 'user') {
      const match = new RegExp(`${RUN_DIRECTIVE_PREFIX}([A-Za-z0-9_-]+)`).exec(personText(message.content));
      if (match?.[1] !== undefined) {
        directive = match[1];
        toolResults = 0;
      }
      continue;
    }
    if (directive !== undefined && message.role === 'tool' && !isBundleLoadResult(message)) {
      toolResults += 1;
    }
  }
  return { directive, toolResults };
}

const USAGE = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 };

function chunkEnvelope(choice: Record<string, unknown>, usage?: typeof USAGE): Record<string, unknown> {
  return {
    id: 'scripted-completion',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'scripted-model',
    choices: [choice],
    ...(usage ? { usage } : {}),
  };
}

interface ScriptedToolCall {
  name: string;
  callId: string;
  argumentsJson: string;
}

function toolCallChunks(toolCalls: ScriptedToolCall[]): Record<string, unknown>[] {
  return [
    chunkEnvelope({ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }),
    chunkEnvelope({
      index: 0,
      delta: {
        tool_calls: toolCalls.map(({ name, callId, argumentsJson }, index) => ({
          index,
          id: callId,
          type: 'function',
          function: { name, arguments: argumentsJson },
        })),
      },
      finish_reason: null,
    }),
    chunkEnvelope({ index: 0, delta: {}, finish_reason: 'tool_calls' }, USAGE),
  ];
}

function textChunks(text: string): Record<string, unknown>[] {
  return [
    chunkEnvelope({ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }),
    chunkEnvelope({ index: 0, delta: {}, finish_reason: 'stop' }, USAGE),
  ];
}

function completionBody({ text, toolCalls }: { text: string | null; toolCalls: ScriptedToolCall[] }) {
  return {
    id: 'scripted-completion',
    object: 'chat.completion',
    created: 0,
    model: 'scripted-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map(call => ({
                  id: call.callId,
                  type: 'function',
                  function: { name: call.name, arguments: call.argumentsJson },
                })),
              }
            : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: USAGE,
  };
}

export async function startScriptedModelServer(): Promise<ScriptedModelServer> {
  const requests: ChatCompletionRequest[] = [];
  let callCounter = 0;

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `scripted model fixture has no route for ${req.url ?? ''}` } }));
      return;
    }

    const body = await readRequestBody(req);
    const parsed: ChatCompletionRequest = {
      model: isRecord(body) && typeof body['model'] === 'string' ? body['model'] : '',
      messages: isRecord(body) ? toChatMessages(body['messages']) : [],
      tools: isRecord(body) ? toAdvertisedTools(body['tools']) : [],
      stream: isRecord(body) && body['stream'] === true,
      chatTemplateKwargs: isRecord(body) ? body['chat_template_kwargs'] : undefined,
    };
    requests.push(parsed);

    const progress = directiveProgress(parsed.messages);
    const pending = pendingDirective(parsed.messages);
    let requestedTool: { match: string; argumentsJson: string } | undefined;
    if (progress.directive === VERIFY_THEN_COMMIT_DIRECTIVE && progress.toolResults < 2) {
      const purpose = progress.toolResults === 0 ? 'verify' : 'commit';
      requestedTool = { match: 'exec', argumentsJson: sandboxArgumentsJson(purpose) };
    } else if (progress.directive === COMMIT_ONLY_DIRECTIVE && progress.toolResults === 0) {
      requestedTool = { match: 'exec', argumentsJson: sandboxArgumentsJson('commit') };
    } else if (progress.directive === WRITE_THEN_SEARCH_DIRECTIVE && progress.toolResults < 2) {
      requestedTool =
        progress.toolResults === 0
          ? { match: 'inert_write', argumentsJson: '{"text":"inert"}' }
          : { match: 'web_search', argumentsJson: JSON.stringify({ query: WEB_SEARCH_QUERY }) };
    } else if (progress.directive === FIND_PLACES_DIRECTIVE && progress.toolResults < 3) {
      const steps = [
        { match: 'tavily_search', argumentsJson: JSON.stringify({ query: FIND_PLACES_QUERY }) },
        { match: 'tavily_extract', argumentsJson: JSON.stringify({ urls: [HARBOUR_URL, GARDEN_URL] }) },
        { match: 'render_places', argumentsJson: JSON.stringify({ places: scriptedPlaces }) },
      ];
      requestedTool = steps[progress.toolResults];
    } else if (progress.directive === BRIEF_DIRECTIVE) {
      requestedTool = briefSteps(parsed.messages)[progress.toolResults];
    } else if (pending !== undefined) {
      requestedTool = { match: pending, argumentsJson: '' };
    }
    const toolName =
      requestedTool === undefined
        ? undefined
        : resolveToolName({ directive: requestedTool.match, tools: parsed.tools });
    const toolCalls: ScriptedToolCall[] = [];
    const threeAtOnceName =
      progress.directive === THREE_AT_ONCE_DIRECTIVE && progress.toolResults === 0
        ? resolveToolName({ directive: 'inert_unannotated', tools: parsed.tools })
        : undefined;
    if (threeAtOnceName !== undefined) {
      for (const text of THREE_AT_ONCE_TEXTS) {
        callCounter += 1;
        toolCalls.push({
          name: threeAtOnceName,
          callId: `call_${String(callCounter)}`,
          argumentsJson: JSON.stringify({ text }),
        });
      }
    } else if (toolName === undefined && requestedTool !== undefined) {
      const bundle = bundleToLoad({ match: requestedTool.match, request: parsed });
      if (bundle !== undefined) {
        callCounter += 1;
        toolCalls.push({
          name: 'load_bundle',
          callId: `call_${String(callCounter)}`,
          argumentsJson: JSON.stringify({ name: bundle }),
        });
      }
    } else if (toolName !== undefined) {
      callCounter += 1;
      toolCalls.push({
        name: toolName,
        callId: `call_${String(callCounter)}`,
        argumentsJson:
          requestedTool?.argumentsJson === '' || requestedTool?.argumentsJson === undefined
            ? argumentsJsonForTool({
                name: toolName,
                callToolServer: callToolServer(parsed.messages),
                text: textArgument(parsed.messages),
              })
            : requestedTool.argumentsJson,
      });
    }

    const rejectingJudge =
      parsed.messages.some(message => messageText(message.content).includes(RELEVANCE_JUDGE_TAG)) &&
      parsed.messages.some(message => messageText(message.content).includes(JUDGE_REJECT_MARKER));
    const quoteToolResult = parsed.messages.some(message =>
      personText(message.content).includes(QUOTE_TOOL_RESULT_DIRECTIVE),
    );
    const replyText = rejectingJudge
      ? '{"helpful":[]}'
      : ((quoteToolResult ? lastToolResultText(parsed.messages) : undefined) ?? FINAL_TEXT);

    if (!parsed.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completionBody({ text: toolCalls.length > 0 ? null : replyText, toolCalls })));
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const chunks = toolCalls.length > 0 ? toolCallChunks(toolCalls) : textChunks(replyText);
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }

  const httpServer: Server = createServer((req, res) => {
    void dispatch(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(
        JSON.stringify({
          error: { message: error instanceof Error ? error.message : 'scripted model fixture failed' },
        }),
      );
    });
  });

  await new Promise<void>(resolve => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('scripted model fixture did not bind a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close(error => {
          if (error) {
            reject(new Error('scripted model fixture failed to close', { cause: error }));
            return;
          }
          resolve();
        });
      }),
  };
}
