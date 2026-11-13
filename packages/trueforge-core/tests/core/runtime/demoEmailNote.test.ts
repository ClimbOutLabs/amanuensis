import { MAIL_CONNECTOR_NAME, MAIL_DRAFT_TOOL_NAME } from '../../../src/core/email/mailConnector/toolContract';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core/permissions/context';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { DEMO_EMAIL_PROMPT } from '../../../src/core/runtime/contextUtils';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeSilentLogger } from '../harnessMocks';

/** Runs one turn and returns the system prompt the model was sent. */
async function systemPromptFor(input: {
  demo: boolean;
  emailSetUp: boolean;
  sentinel?: boolean;
  subAgent?: boolean;
}): Promise<string> {
  const requests: LLMCreateParamsStreaming[] = [];
  const create = jest.fn((request: LLMCreateParamsStreaming) => {
    requests.push(request);
    return finalAnswerStream('Done.');
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
      instruction: 'test',
      toolSets: [],
      setUpConnectorNames: input.emailSetUp ? [MAIL_CONNECTOR_NAME] : [],
    },
    parent: input.subAgent === true ? { thread_id: 'root', tool_call_id: 'launch' } : undefined,
    sentinel:
      input.sentinel === false
        ? undefined
        : createSentinelHostContext({
            tenant_id: 't1',
            created_by: 'u1',
            conversation_id: 'conv-1',
            services: {
              ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
              demoSendAllowlist: input.demo ? [] : null,
            },
          }),
    context: [{ role: 'user', content: 'Send it.' }],
  });
  for await (const _event of thread.execute({ signal: new AbortController().signal })) {
    // Draining is enough; the assertion is on the request sent to the model.
  }
  const system = requests[0]?.messages.find(message => message.role === 'system')?.content;
  return typeof system === 'string' ? system : '';
}

describe('the demo email note', () => {
  it('is in the prompt on a demo instance with Email set up', async () => {
    expect(await systemPromptFor({ demo: true, emailSetUp: true })).toContain(DEMO_EMAIL_PROMPT);
  });

  it('is not in the prompt when this is not a demo', async () => {
    expect(await systemPromptFor({ demo: false, emailSetUp: true })).not.toContain(DEMO_EMAIL_PROMPT);
  });

  it('is not in the prompt on a demo without Email set up', async () => {
    expect(await systemPromptFor({ demo: true, emailSetUp: false })).not.toContain(DEMO_EMAIL_PROMPT);
  });

  it('is in the prompt of a sub-agent thread on a demo', async () => {
    expect(await systemPromptFor({ demo: true, emailSetUp: true, subAgent: true })).toContain(DEMO_EMAIL_PROMPT);
  });

  it('is not in the prompt when the thread has no sentinel', async () => {
    expect(await systemPromptFor({ demo: true, emailSetUp: true, sentinel: false })).not.toContain(DEMO_EMAIL_PROMPT);
  });

  it('names only the Email account and the draft tool, and says nothing about Gmail', () => {
    expect(DEMO_EMAIL_PROMPT).toContain('the Email account cannot send');
    expect(DEMO_EMAIL_PROMPT).toContain(`with ${MAIL_DRAFT_TOOL_NAME};`);
    expect(DEMO_EMAIL_PROMPT.toLowerCase()).not.toContain('gmail');
    expect(DEMO_EMAIL_PROMPT).not.toContain('This demo cannot send email');
  });
});
