/**
 * A helper the assistant starts for a task gets the connectors the chat has attached, including
 * the ones attached by default, even though the helper's own setup attaches nothing.
 */
import type { ITurnResourceResolver } from '../../src/agent-session/ITurnResourceResolver';
import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { dynamicSubAgents } from '../../src/core/capabilities/builtins/DynamicSubAgents';
import type { LLMCreateParamsStreaming } from '../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import { defaultSentinelServices } from '../../src/core/permissions';
import { makeMockIMCPServer } from '../core/harnessMocks';
import { makeAgentSpec, makeMockILLM, makeTestResolver, mintTestTurnId } from './testHelpers';

const OWNER = { subject_id: 'user-1', subject_type: 'user' as const, subject_display_name: 'user-1' };
const SUB_AGENT_ARGS = JSON.stringify({ name: 'finder', input: 'find the newest note from Ana' });

function toolCallStream(call: {
  id: string;
  name: string;
  args: string;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const toolCall = { id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.args } };
  return (async function* () {
    yield {
      id: `chunk-${call.id}`,
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] },
          finish_reason: 'tool_calls',
        },
      ],
    };
    return {
      output: { role: 'assistant', content: null, tool_calls: [toolCall] },
      usage: getEmptyUsage(),
      finish_reason: 'tool_calls',
    };
  })();
}

function textStream(text: string): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  return (async function* () {
    yield {
      id: 'chunk-text',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    };
    return { output: { role: 'assistant', content: text }, usage: getEmptyUsage(), finish_reason: 'stop' };
  })();
}

describe('connectors a helper gets', () => {
  it('lets a helper use the connector the chat attached, though its own setup attaches none', async () => {
    const connector = makeMockIMCPServer({
      name: 'Email',
      preload: true,
      tools: [
        {
          name: 'search_notes',
          description: 'Search notes',
          inputSchema: { type: 'object', properties: {} },
          preload: true,
        },
      ],
    });

    const requests: LLMCreateParamsStreaming[] = [];
    const replies = [
      toolCallStream({ id: 'call-helper', name: 'create_sub_agent', args: SUB_AGENT_ARGS }),
      toolCallStream({ id: 'call-search', name: 'search_notes', args: '{}' }),
    ];
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      return replies.shift() ?? textStream('Finished.');
    });

    const sentinelServices = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const base = makeTestResolver({ modelClient: makeMockILLM({ create }) });
    const resolver: ITurnResourceResolver = {
      get logger() {
        return base.logger;
      },
      get webSearchTurn() {
        return base.webSearchTurn;
      },
      createTracing: () => base.createTracing(),
      resolveAgentSpec: input => base.resolveAgentSpec(input),
      resolveSandbox: input => base.resolveSandbox(input),
      resolveAgentDefinition: async input => {
        const resolved = await base.resolveAgentDefinition(input);
        const isHelper = input.agent_info !== undefined;
        return {
          ...resolved,
          definition: { ...resolved.definition, toolSets: isHelper ? [] : [connector] },
          extraCapabilities: [
            ...(resolved.extraCapabilities ?? []),
            dynamicSubAgents({ sandboxAvailable: false, tracing: base.createTracing() }),
          ],
        };
      },
      close: () => base.close(),
    };

    const sessions = new Sessions({ sessionStore: new InMemorySessionStore(), sentinelServices });
    const session = await sessions.create({
      tenant_id: 't',
      session_id: 'helper-connectors',
      external_id: 'helper-connectors-1',
      created_by_subject: OWNER,
      agent: { type: 'inline', spec: makeAgentSpec() },
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'Find the newest note from Ana' }],
      signal: new AbortController().signal,
      resolver,
    });
    for await (const event of turn.stream()) {
      void event;
    }

    // The second model request is the helper's first: the chat's connector tool is offered to it.
    const helperTools = (requests[1]?.tools ?? []).flatMap(tool =>
      tool.type === 'function' ? [tool.function.name] : [],
    );
    expect(helperTools).toContain('search_notes');
  });
});
