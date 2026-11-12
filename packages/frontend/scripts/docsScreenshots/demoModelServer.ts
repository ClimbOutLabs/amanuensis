/**
 * A small OpenAI-compatible model for the docs screenshots. It answers each message from a fixed list of
 * exchanges, so every picture shows the same natural conversation. It never reaches the internet.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';

import {
  completionBody,
  personText,
  readRequestBody,
  textChunks,
  toAdvertisedTools,
  toChatMessages,
  toolCallChunks,
  type AdvertisedTool,
  type ChatMessage,
  type ScriptedToolCall,
} from '../../../trueforge/tests/fixtures/scriptedModelServer.ts';

/** A tool Aman asks to use. One that changes something shows a card that waits for Allow. */
export interface DemoToolCall {
  /** The end of the tool's name, such as `create_event`. */
  match: string;
  arguments: Record<string, unknown>;
}

/** One thing a person asks, and how Aman answers it. */
export interface DemoExchange {
  /** What the person types. The latest message that contains this text picks the exchange. */
  ask: string;
  /** Aman's answer, given once every tool below has answered. */
  reply: string;
  /** Tools Aman uses first, one after another. */
  tools?: readonly DemoToolCall[];
}

export interface DemoModelServer {
  /** Value for a custom model provider's `base_url`. */
  baseUrl: string;
  /** Advertised tool names seen so far, so a missing tool can be reported in plain words. */
  toolsSeen: () => ReadonlySet<string>;
  close: () => Promise<void>;
}

/** The answer for any request the list does not cover. */
const FALLBACK_REPLY = 'Sure. Tell me a little more and I will take it from there.';
/**
 * Answers to the server's own background questions, found by a phrase their prompt holds. They keep nothing
 * new, so the demo memories stay exactly as the run saved them.
 */
const BACKGROUND_REPLIES: readonly { prompt: string; reply: string }[] = [
  { prompt: '{"facts":', reply: '{"facts": []}' },
  { prompt: '<knowledge-relevance-judge', reply: '{"helpful": []}' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : '')).join(' ');
}

/** The exchange the person's latest message asks for, and how many tools have answered since. */
function currentExchange({ messages, exchanges }: { messages: ChatMessage[]; exchanges: readonly DemoExchange[] }): {
  exchange: DemoExchange | undefined;
  toolsAnswered: number;
} {
  let exchange: DemoExchange | undefined;
  let toolsAnswered = 0;
  for (const message of messages) {
    if (message.role === 'user') {
      const text = personText(message.content);
      const found = exchanges.find(candidate => text.includes(candidate.ask));
      if (found !== undefined) {
        exchange = found;
        toolsAnswered = 0;
      }
    } else if (message.role === 'tool') {
      toolsAnswered += 1;
    }
  }
  return { exchange, toolsAnswered };
}

function advertisedName({ match, tools }: { match: string; tools: AdvertisedTool[] }): string | undefined {
  for (const tool of tools) {
    const name = tool.function?.name;
    if (typeof name === 'string' && name.endsWith(match)) return name;
  }
  return undefined;
}

function writeStream({ res, chunks }: { res: ServerResponse; chunks: Record<string, unknown>[] }): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

export async function startDemoModelServer({
  exchanges,
  modelIds,
}: {
  exchanges: readonly DemoExchange[];
  modelIds: readonly string[];
}): Promise<DemoModelServer> {
  const toolsSeen = new Set<string>();
  let callCounter = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url?.endsWith('/models') === true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: modelIds.map(id => ({ id, object: 'model' })) }));
        return;
      }
      if (req.url?.endsWith('/chat/completions') !== true) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Not found' } }));
        return;
      }
      const body = await readRequestBody(req);
      const messages = isRecord(body) ? toChatMessages(body['messages']) : [];
      const tools = isRecord(body) ? toAdvertisedTools(body['tools']) : [];
      const stream = isRecord(body) && body['stream'] === true;
      for (const tool of tools) {
        if (typeof tool.function?.name === 'string') toolsSeen.add(tool.function.name);
      }

      const { exchange, toolsAnswered } = currentExchange({ messages, exchanges });
      const toolCalls: ScriptedToolCall[] = [];
      const wanted = exchange?.tools?.[toolsAnswered];
      if (wanted !== undefined && tools.length > 0) {
        const name = advertisedName({ match: wanted.match, tools });
        if (name === undefined) {
          const offered = tools.map(tool => tool.function?.name).join(', ');
          throw new Error(`The demo chat needs the "${wanted.match}" tool, but this chat offers only: ${offered}.`);
        }
        callCounter += 1;
        toolCalls.push({
          name,
          callId: `call_${String(callCounter)}`,
          argumentsJson: JSON.stringify(wanted.arguments),
        });
      }
      // Only a chat answer speaks for Aman: one that offers tools, or streams, as the help guide's does without tools.
      // Background questions get the plain fallback.
      const chatAnswer = tools.length > 0 || stream;
      const background = chatAnswer
        ? undefined
        : BACKGROUND_REPLIES.find(answer => messages.some(message => textOf(message.content).includes(answer.prompt)));
      const text = background?.reply ?? (chatAnswer && exchange !== undefined ? exchange.reply : FALLBACK_REPLY);

      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(completionBody({ text: toolCalls.length > 0 ? null : text, toolCalls })));
        return;
      }
      writeStream({ res, chunks: toolCalls.length > 0 ? toolCallChunks(toolCalls) : textChunks(text) });
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: error instanceof Error ? error.message : 'The demo model failed.' } }),
      );
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The demo model could not open a port.');

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    toolsSeen: () => toolsSeen,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => {
          if (error) reject(new Error('The demo model did not stop.', { cause: error }));
          else resolve();
        });
      }),
  };
}
