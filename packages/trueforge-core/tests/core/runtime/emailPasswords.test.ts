import { MAIL_CONNECTOR_TOOL_NAMES } from '../../../src/core/email/mailConnector/toolContract';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { EMAIL_PASSWORD_PROMPT } from '../../../src/core/runtime/contextUtils';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

/**
 * The app password used to set the account up through Settings in these tests. It stands in for
 * a real one: distinctive, so if it ever turns up in a model request, a tool schema, or a tool
 * result, the leak is unmistakable.
 */
const CANARY = 'CANARY-APP-PASSWORD-7f3d9';

const MAIL_CONTENT = 'Subject: Quarterly report\nFrom: sender@example.com\nThe numbers are in.';

/** The Email connector as a tool set: exactly the contract's tools, answering with plain mail content. */
function makeEmailToolSet(): IToolSet {
  const toolSet = makeMockIMCPServer({
    name: 'Email',
    preload: true,
    tools: MAIL_CONNECTOR_TOOL_NAMES.map(name => ({
      name,
      description: `Mail tool ${name}`,
      inputSchema: OBJECT_INPUT_SCHEMA,
      preload: true,
    })),
  });
  jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
    Promise.resolve({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: false,
    }),
  );
  jest.mocked(toolSet.callTool).mockImplementation(params => {
    if (params.name === 'list_emails_metadata' || params.name === 'get_emails_content') {
      return Promise.resolve(toolResultResponse({ text: MAIL_CONTENT }));
    }
    return Promise.resolve(toolResultResponse({ text: 'Done.' }));
  });
  return toolSet;
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* toolCallStream(input: {
  id: string;
  name: string;
  args: Record<string, unknown>;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = {
    id: input.id,
    type: 'function' as const,
    function: { name: input.name, arguments: JSON.stringify(input.args) },
  };
  yield {
    id: `chunk-${input.id}`,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [call] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

/** Runs one turn with a scripted model and returns every request the model was sent. */
async function runScriptedTurn(input: {
  instruction: string;
  message: string;
  streams: AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown>[];
}): Promise<LLMCreateParamsStreaming[]> {
  const requests: LLMCreateParamsStreaming[] = [];
  const queue = [...input.streams];
  const create = jest.fn((request: LLMCreateParamsStreaming) => {
    requests.push(request);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error('the scripted model ran out of replies');
    }
    return next;
  });
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: input.instruction,
      toolSets: [makeEmailToolSet()],
    },
    context: [{ role: 'user', content: input.message }],
  });
  for await (const _event of thread.execute({ signal: new AbortController().signal })) {
    // Draining is enough; the assertions are on the requests sent to the model.
  }
  return requests;
}

describe('the app password never reaches the model', () => {
  it('a chat that reads and sends mail after setup sends no request containing the password', async () => {
    const requests = await runScriptedTurn({
      instruction: 'test',
      message: 'Read my newest email, then send a short reply to the sender.',
      streams: [
        toolCallStream({ id: 'call-1', name: 'list_emails_metadata', args: { mailbox: 'INBOX' } }),
        toolCallStream({
          id: 'call-2',
          name: 'send_email',
          args: { to: 'sender@example.com', subject: 'Re: Quarterly report', body: 'Thanks, received.' },
        }),
        finalAnswerStream('I read it and sent the reply.'),
      ],
    });
    // The chat really read and sent mail: later requests carry the tool results.
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(requests[1])).toContain('Quarterly report');
    expect(JSON.stringify(requests[2])).toContain('Done.');
    // And no request, system prompt, tool schema, tool call or tool result carries the password.
    for (const request of requests) {
      expect(JSON.stringify(request)).not.toContain(CANARY);
    }
  });

  it('no tool offered on the Email connector could take a password', () => {
    for (const name of MAIL_CONNECTOR_TOOL_NAMES) {
      expect(name.toLowerCase()).not.toContain('password');
      expect(name.toLowerCase()).not.toContain('setup');
      expect(name.toLowerCase()).not.toContain('connect');
      expect(name.toLowerCase()).not.toContain('account');
    }
  });
});

describe('a password pasted into chat', () => {
  it('the system prompt always tells the model to point at Settings, whatever the persona says', async () => {
    const requests = await runScriptedTurn({
      instruction: 'You are a terse senior engineer. Use precise technical terms.',
      message: `Set up my email with this app password: ${CANARY}`,
      streams: [finalAnswerStream('I cannot do that here.')],
    });
    const system = requests[0]?.messages.find(message => message.role === 'system')?.content;
    const prompt = typeof system === 'string' ? system : '';
    expect(prompt).toContain('<email-passwords>');
    expect(prompt).toContain(EMAIL_PASSWORD_PROMPT.trim());
    expect(prompt).toContain('Never ask for a password in chat');
    expect(prompt).toContain('Settings, Connectors, Email');
    // The host's own prompt parts never carry a password either; only the person's own
    // message does, and it is theirs.
    expect(EMAIL_PASSWORD_PROMPT).not.toContain(CANARY);
  });
});
