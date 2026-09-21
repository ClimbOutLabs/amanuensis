/**
 * OpenAI-compatible chat-completions endpoint that answers from the prompt instead
 * of a model, so the approval tests exercise the real server path (VercelAILLM →
 * HTTP → tool call → approval gate) with a deterministic tool-calling "model".
 *
 * Contract: a user message containing `run:<tool>` produces a tool call against
 * the advertised tool whose name contains `<tool>`; once its scripted sequence
 * is complete, the turn is closed with plain text.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const RUN_DIRECTIVE_PREFIX = 'run:';
export const FINAL_TEXT = 'inert connector work is finished.';
export const VERIFY_THEN_COMMIT_DIRECTIVE = 'verify_then_commit';
export const COMMIT_ONLY_DIRECTIVE = 'commit_only';
export const PERSONA_SELECTION_PREFLIGHT_MARKER = '<persona-selection-preflight version="persona-selection/v1">';

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

interface PersonaSelectionFixtureInput {
  message: string;
  default_assistant_names: string[];
  personas: { id: string; names: string[] }[];
}

function parsePersonaSelectionFixtureInput(messages: ChatMessage[]): PersonaSelectionFixtureInput | undefined {
  const hasPreflight = messages.some(
    message => message.role === 'system' && messageText(message.content).includes(PERSONA_SELECTION_PREFLIGHT_MARKER),
  );
  if (!hasPreflight) {
    return undefined;
  }
  const userText = messages.findLast(message => message.role === 'user');
  if (userText === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(messageText(userText.content));
    if (!isRecord(value) || typeof value['message'] !== 'string') {
      return undefined;
    }
    const defaultNames = Array.isArray(value['default_assistant_names'])
      ? value['default_assistant_names'].filter((name): name is string => typeof name === 'string')
      : [];
    const personas = Array.isArray(value['personas'])
      ? value['personas'].flatMap(persona => {
          if (!isRecord(persona) || typeof persona['id'] !== 'string' || !Array.isArray(persona['names'])) {
            return [];
          }
          return [
            {
              id: persona['id'],
              names: persona['names'].filter((name): name is string => typeof name === 'string'),
            },
          ];
        })
      : [];
    return { message: value['message'], default_assistant_names: defaultNames, personas };
  } catch {
    return undefined;
  }
}

/** Deterministic stand-in for the bounded persona-selection call used by HTTP integration tests. */
function personaSelectionFixtureResult(input: PersonaSelectionFixtureInput): string {
  if (input.message.includes('[malformed persona selection]')) {
    return '{"action":"select_persona"';
  }
  const lower = input.message.toLowerCase();
  const defaultName = input.default_assistant_names.find(name => lower.includes(name.toLowerCase()));
  if (
    defaultName !== undefined &&
    (lower.includes('converse with') || lower.startsWith(`${defaultName.toLowerCase()},`))
  ) {
    return JSON.stringify({ action: 'select_default', persona_id: null, evidence: input.message });
  }
  const selected = input.personas.find(persona =>
    persona.names.some(name => lower.includes(`could ${name.toLowerCase()} answer`)),
  );
  if (selected !== undefined) {
    return JSON.stringify({ action: 'select_persona', persona_id: selected.id, evidence: input.message });
  }
  const mentioned = input.personas.flatMap(persona => persona.names).find(name => lower.includes(name.toLowerCase()));
  return JSON.stringify({ action: 'keep', persona_id: null, evidence: mentioned ?? defaultName ?? '' });
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

/** The `run:<tool>` directive still awaiting a tool result, or undefined when none is open. */
function pendingDirective(messages: ChatMessage[]): string | undefined {
  let directive: string | undefined;
  for (const message of messages) {
    if (message.role === 'tool') {
      directive = undefined;
      continue;
    }
    if (message.role !== 'user') {
      continue;
    }
    const text = messageText(message.content);
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
function argumentsJsonForTool(name: string): string {
  if (name === 'call_tool') {
    return '{"mcp_server":"inert","tool_name":"ask_memory","input":{"question":"inert"}}';
  }
  return name.includes('ask_memory') ? '{"question":"inert"}' : '{"text":"inert"}';
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
      const match = new RegExp(`${RUN_DIRECTIVE_PREFIX}([A-Za-z0-9_-]+)`).exec(messageText(message.content));
      if (match?.[1] !== undefined) {
        directive = match[1];
        toolResults = 0;
      }
      continue;
    }
    if (directive !== undefined && message.role === 'tool') {
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

function toolCallChunks({
  name,
  callId,
  argumentsJson,
}: {
  name: string;
  callId: string;
  argumentsJson: string;
}): Record<string, unknown>[] {
  return [
    chunkEnvelope({ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }),
    chunkEnvelope({
      index: 0,
      delta: {
        tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: argumentsJson } }],
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

function completionBody({
  text,
  toolCall,
}: {
  text: string | null;
  toolCall: { name: string; callId: string; argumentsJson: string } | null;
}) {
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
          ...(toolCall
            ? {
                tool_calls: [
                  {
                    id: toolCall.callId,
                    type: 'function',
                    function: { name: toolCall.name, arguments: toolCall.argumentsJson },
                  },
                ],
              }
            : {}),
        },
        finish_reason: toolCall ? 'tool_calls' : 'stop',
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

    const personaSelectionInput = parsePersonaSelectionFixtureInput(parsed.messages);
    if (personaSelectionInput !== undefined) {
      const result = personaSelectionFixtureResult(personaSelectionInput);
      if (!parsed.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(completionBody({ text: result, toolCall: null })));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const chunk of textChunks(result)) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const progress = directiveProgress(parsed.messages);
    const pending = pendingDirective(parsed.messages);
    let requestedTool: { match: string; argumentsJson: string } | undefined;
    if (progress.directive === VERIFY_THEN_COMMIT_DIRECTIVE && progress.toolResults < 2) {
      const purpose = progress.toolResults === 0 ? 'verify' : 'commit';
      requestedTool = { match: 'exec', argumentsJson: sandboxArgumentsJson(purpose) };
    } else if (progress.directive === COMMIT_ONLY_DIRECTIVE && progress.toolResults === 0) {
      requestedTool = { match: 'exec', argumentsJson: sandboxArgumentsJson('commit') };
    } else if (pending !== undefined) {
      requestedTool = { match: pending, argumentsJson: '' };
    }
    const toolName =
      requestedTool === undefined
        ? undefined
        : resolveToolName({ directive: requestedTool.match, tools: parsed.tools });
    let toolCall: { name: string; callId: string; argumentsJson: string } | null = null;
    if (toolName !== undefined) {
      callCounter += 1;
      toolCall = {
        name: toolName,
        callId: `call_${String(callCounter)}`,
        argumentsJson:
          requestedTool?.argumentsJson === '' || requestedTool?.argumentsJson === undefined
            ? argumentsJsonForTool(toolName)
            : requestedTool.argumentsJson,
      };
    }

    if (!parsed.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completionBody({ text: toolCall ? null : FINAL_TEXT, toolCall })));
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const chunks = toolCall ? toolCallChunks(toolCall) : textChunks(FINAL_TEXT);
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
