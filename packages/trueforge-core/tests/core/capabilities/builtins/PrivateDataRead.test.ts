import {
  PRIVATE_DATA_READ_STATE_KEY,
  privateDataReadCapability,
} from '../../../../src/core/capabilities/builtins/PrivateDataRead';
import {
  createWebSearchTurnState,
  hasReadPrivateData,
  markPrivateDataRead,
  privateTextForChecks,
} from '../../../../src/core/permissions/webSearch';
import type { ContextMessage } from '../../../../src/core/runtime/AgentThread.types';
import { getEmptyCurrentContextUsage } from '../../../../src/core/runtime/contextUsage';
import { makeUnknownToolInfo } from '../../../../src/core/runtime/contextUtils';

function assistantCalling(name: string): ContextMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call-1', type: 'function', function: { name, arguments: '{}' }, tool_info: makeUnknownToolInfo(name) },
    ],
  };
}

async function collect(iterable: Iterable<unknown> | AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

const execution = (context: ContextMessage[]) => ({
  threadId: 'main',
  currentContextUsage: getEmptyCurrentContextUsage(),
  context,
});

const SAVED = [{ type: 'internal.capability.state', key: PRIVATE_DATA_READ_STATE_KEY, state: true }];

describe('privateDataReadCapability', () => {
  it('puts a saved flag back at the start of the next turn', () => {
    const turn = createWebSearchTurnState();
    privateDataReadCapability({ turn, persisted: true }).state?.load(true);
    expect(hasReadPrivateData(turn)).toBe(true);
  });

  it('ignores a saved value that is not true', () => {
    const turn = createWebSearchTurnState();
    privateDataReadCapability({ turn, persisted: true }).state?.load(false);
    expect(hasReadPrivateData(turn)).toBe(false);
  });

  it('saves the flag once, after the tool call that set it', async () => {
    const turn = createWebSearchTurnState();
    const [processor] = privateDataReadCapability({ turn, persisted: true }).postToolCallProcessors ?? [];
    expect(await collect(processor?.processPostToolCall(execution([])) ?? [])).toEqual([]);
    markPrivateDataRead(turn);
    expect(await collect(processor?.processPostToolCall(execution([])) ?? [])).toEqual(SAVED);
    expect(await collect(processor?.processPostToolCall(execution([])) ?? [])).toEqual([]);
  });

  describe('a thread that was forked, rewound or cut off before the flag was saved', () => {
    const preLLM = (context: ContextMessage[]) => {
      const turn = createWebSearchTurnState();
      const [processor] = privateDataReadCapability({ turn, persisted: true }).preLLMProcessors ?? [];
      return { turn, run: () => collect(processor?.processPreLLM(execution(context)) ?? []) };
    };

    it('reads the mail tool calls still in its context and treats the chat as having read mail', async () => {
      const { turn, run } = preLLM([assistantCalling('read_email')]);
      expect(await run()).toEqual(SAVED);
      expect(hasReadPrivateData(turn)).toBe(true);
    });

    it('also when the tool name is qualified by its server', async () => {
      const { turn, run } = preLLM([assistantCalling('gmail__list_inbox_threads')]);
      await run();
      expect(hasReadPrivateData(turn)).toBe(true);
    });

    it('also counts a calendar read, bare or qualified by its server', async () => {
      for (const name of ['list_events', 'google_calendar__get_event']) {
        const { turn, run } = preLLM([assistantCalling(name)]);
        expect(await run()).toEqual(SAVED);
        expect(hasReadPrivateData(turn)).toBe(true);
      }
    });

    it('does nothing for a context with no mail call', async () => {
      const { turn, run } = preLLM([assistantCalling('web_search')]);
      expect(await run()).toEqual([]);
      expect(hasReadPrivateData(turn)).toBe(false);
    });
  });

  describe('the text of mail and calendar results', () => {
    const MAIL = 'From: Maria Costa <maria.costa@harbour-clinic.example>';

    function resultOf(content: string): ContextMessage {
      return { role: 'tool', tool_call_id: 'call-1', content };
    }

    const postToolCall = async (turn: ReturnType<typeof createWebSearchTurnState>, context: ContextMessage[]) => {
      const [processor] = privateDataReadCapability({ turn, persisted: true }).postToolCallProcessors ?? [];
      await collect(processor?.processPostToolCall(execution(context)) ?? []);
    };

    it('keeps the result of a mail read for the checks', async () => {
      const turn = createWebSearchTurnState();
      markPrivateDataRead(turn);
      await postToolCall(turn, [assistantCalling('read_email'), resultOf(MAIL)]);
      expect(privateTextForChecks(turn)).toEqual([MAIL]);
    });

    it('keeps a calendar read result, qualified by its server', async () => {
      const turn = createWebSearchTurnState();
      markPrivateDataRead(turn);
      await postToolCall(turn, [assistantCalling('google_calendar__list_events'), resultOf('{"summary":"Dinner"}')]);
      expect(privateTextForChecks(turn)).toEqual(['{"summary":"Dinner"}']);
    });

    it('keeps no text from a tool that is not a mail or calendar read', async () => {
      const turn = createWebSearchTurnState();
      markPrivateDataRead(turn);
      await postToolCall(turn, [assistantCalling('web_search'), resultOf('Lisbon tapas')]);
      expect(privateTextForChecks(turn)).toBeUndefined();
    });

    it('has no text to check against when the mark was only restored from saved state', async () => {
      const turn = createWebSearchTurnState();
      privateDataReadCapability({ turn, persisted: true }).state?.load(true);
      await postToolCall(turn, [assistantCalling('read_email'), resultOf(MAIL)]);
      expect(privateTextForChecks(turn)).toBeUndefined();
    });

    it('has no text to check against when the mail call was only in the context before this turn', async () => {
      const turn = createWebSearchTurnState();
      const [preLLM] = privateDataReadCapability({ turn, persisted: true }).preLLMProcessors ?? [];
      await collect(preLLM?.processPreLLM(execution([assistantCalling('read_email')])) ?? []);
      await postToolCall(turn, [assistantCalling('read_email'), resultOf(MAIL)]);
      expect(privateTextForChecks(turn)).toBeUndefined();
    });
  });
});

describe('private read text from a sub-agent and from a read that never returned', () => {
  const MAIL = 'From: Maria Costa <maria.costa@harbour-clinic.example>';
  const resultOf = (content: string): ContextMessage => ({ role: 'tool', tool_call_id: 'call-1', content });

  it('keeps the mail text a sub-agent read, and saves no flag for that thread', async () => {
    const turn = createWebSearchTurnState();
    const capability = privateDataReadCapability({ turn, persisted: false });
    expect(capability.state).toBeUndefined();
    const [processor] = capability.postToolCallProcessors ?? [];
    markPrivateDataRead(turn);
    const yielded = await collect(
      processor?.processPostToolCall(execution([assistantCalling('read_email'), resultOf(MAIL)])) ?? [],
    );
    expect(yielded).toEqual([]);
    expect(privateTextForChecks(turn)).toEqual([MAIL]);
  });
});
