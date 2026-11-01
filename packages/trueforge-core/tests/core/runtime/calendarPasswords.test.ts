import { CALDAV_SERVER_NAME } from '../../../src/core/calendar/caldav/toolContract';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { CALENDAR_PASSWORD_PROMPT, EMAIL_PASSWORD_PROMPT } from '../../../src/core/runtime/contextUtils';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeSilentLogger } from '../harnessMocks';

const CANARY = 'CANARY-APP-PASSWORD-7f3d9';

/** Runs one turn and returns the system prompt the model was sent. */
async function systemPromptFor(input: { message: string; setUpConnectorNames: string[] }): Promise<string> {
  const requests: LLMCreateParamsStreaming[] = [];
  const create = jest.fn((request: LLMCreateParamsStreaming) => {
    requests.push(request);
    return finalAnswerStream('Understood.');
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
      instruction: 'You are a terse senior engineer.',
      toolSets: [],
      setUpConnectorNames: input.setUpConnectorNames,
    },
    context: [{ role: 'user', content: input.message }],
  });
  for await (const _event of thread.execute({ signal: new AbortController().signal })) {
    // Draining is enough; the assertion is on the request sent to the model.
  }
  const system = requests[0]?.messages.find(message => message.role === 'system')?.content;
  return typeof system === 'string' ? system : '';
}

describe('a calendar password pasted into chat', () => {
  it('points at Settings when Calendar is set up, and names Calendar, not Email', async () => {
    const prompt = await systemPromptFor({
      message: `Connect my calendar with this app password: ${CANARY}`,
      setUpConnectorNames: [CALDAV_SERVER_NAME],
    });
    expect(prompt).toContain('<calendar-passwords>');
    expect(prompt).toContain(CALENDAR_PASSWORD_PROMPT.trim());
    expect(prompt).toContain('Settings, Connectors, Calendar');
    expect(prompt).not.toContain('<email-passwords>');
    expect(CALENDAR_PASSWORD_PROMPT).not.toContain(CANARY);
  });

  it('sends no calendar-password section when Calendar is not set up', async () => {
    const prompt = await systemPromptFor({ message: 'Hello.', setUpConnectorNames: [] });
    expect(prompt).not.toContain('<calendar-passwords>');
    expect(prompt).not.toContain(CALENDAR_PASSWORD_PROMPT.trim());
  });

  it('keeps the Email wording as it was', () => {
    expect(EMAIL_PASSWORD_PROMPT).toBe(
      'Email is connected only in Settings, under Connectors, Email, with an app password you never see. Never ask for a password in chat. If someone pastes a password or asks you to connect email with it, do not use it, save it, or pass it to a tool; tell them to enter it in Settings, Connectors, Email instead.',
    );
  });
});
