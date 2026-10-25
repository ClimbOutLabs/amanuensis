/**
 * Checking a list of shows through a whole chat: the session store, each turn's own resolver, the model and
 * the connector, as the server runs them. The scripted model reads the web guidance with load_bundle first,
 * then searches the way that guidance tells it to: several short searches when the guidance says to split a
 * list, and one long search when it does not. Invented hosts only; the shows are real titles the person named.
 */
import { EventType } from '../../src/agent-session/schemas/events';
import type { LLMCreateParamsStreaming } from '../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { setupSearchChat, textStream } from './searchTurnHarness';

const SHOWS = [
  'The Great British Baking Show',
  'Stranger Things',
  'The Last of Us',
  'Better Call Saul',
  'The White Lotus',
  'True Detective',
  'Slow Horses',
  'The Pitt',
  'Severance',
  'Fallout',
  'Shogun',
];

/** The shows in groups of a few, as a model following the split guidance would search them. */
const GROUPS: string[][] = [SHOWS.slice(0, 3), SHOWS.slice(3, 6), SHOWS.slice(6, 9), SHOWS.slice(9)];

const say = (text: string) => [{ type: EventType.USER_MESSAGE, content: text }];

interface CallSpec {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* callsStream(
  specs: CallSpec[],
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const toolCalls = specs.map(spec => ({
    id: spec.id,
    type: 'function' as const,
    function: { name: spec.name, arguments: JSON.stringify(spec.args) },
  }));
  yield {
    id: 'chunk-calls',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', tool_calls: toolCalls.map((call, index) => ({ index, ...call })) },
        finish_reason: 'tool_calls',
      },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: toolCalls },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

/** The text of every tool result the model has been given in this request, guidance included. */
function toolTexts(request: LLMCreateParamsStreaming): string[] {
  return request.messages.flatMap(message =>
    message.role === 'tool' && typeof message.content === 'string' ? [message.content] : [],
  );
}

/**
 * A model that reads the web guidance before searching, then follows what it says about a list.
 * The split wording is read from the guidance the host actually sent, never assumed: with the
 * wording absent, this same model puts the whole list into one long search, as a model that has
 * only the old guidance would.
 */
function guidanceFollowingModel(request: LLMCreateParamsStreaming) {
  const texts = toolTexts(request);
  if (texts.some(text => text.includes('"results"'))) {
    return textStream('Here is the latest on each show.');
  }
  const guidance = texts.find(text => text.includes('Guidance for web'));
  if (guidance === undefined) {
    return callsStream([{ id: 'call-guidance', name: 'load_bundle', args: { name: 'web' } }]);
  }
  const splitsList =
    guidance.includes('Search for one topic at a time.') &&
    guidance.includes('run several short searches of a few items each instead of one long search');
  if (!splitsList) {
    return callsStream([
      {
        id: 'call-search-1',
        name: 'lookup',
        args: { query: `Please check the latest news for these shows: ${SHOWS.join(', ')}` },
      },
    ]);
  }
  return callsStream(
    GROUPS.map((group, index) => ({
      id: `call-search-${String(index + 1)}`,
      name: 'lookup',
      args: { query: `Latest news for ${group.join(', ')}` },
    })),
  );
}

/** The query of every search the connector was actually asked to run, in the order it ran them. */
function ranQueries(chat: Awaited<ReturnType<typeof setupSearchChat>>): string[] {
  const queries: string[] = [];
  const calls: readonly unknown[] = chat.callTool.mock.calls;
  for (const call of calls) {
    if (!Array.isArray(call)) {
      continue;
    }
    const params: unknown = call[0];
    if (typeof params !== 'object' || params === null || !('arguments' in params)) {
      continue;
    }
    const args: unknown = params.arguments;
    if (typeof args === 'object' && args !== null && 'query' in args && typeof args.query === 'string') {
      queries.push(args.query);
    }
  }
  return queries;
}

describe('checking a list of 11 TV shows', () => {
  it('makes several short searches, and none is held back for length', async () => {
    const chat = await setupSearchChat();
    chat.callTool.mockImplementation(() => Promise.resolve(toolResultResponse({ text: '{"results":[]}' })));
    chat.create.mockImplementation(guidanceFollowingModel);

    const turn = await chat.run({
      messages: say(
        `Please check the latest news for these shows: ${SHOWS.join(', ')}. Are new episodes coming for each of them?`,
      ),
    });

    const queries = ranQueries(chat);
    // Several searches ran, covering every show, a few shows in each.
    expect(queries.length).toBeGreaterThanOrEqual(3);
    expect(queries.length).toBeLessThanOrEqual(6);
    for (const show of SHOWS) {
      expect(queries.some(query => query.includes(show))).toBe(true);
    }
    for (const query of queries) {
      expect(query.length).toBeLessThanOrEqual(200);
      expect(SHOWS.filter(show => query.includes(show)).length).toBeLessThanOrEqual(3);
    }
    // No search was held for the person to approve: every search ran, and the turn shows no card.
    expect(chat.callTool).toHaveBeenCalledTimes(queries.length);
    const state = JSON.stringify((await chat.session.getTurn(turn.id))?.state);
    expect(state).not.toContain('approval');
  });
});
