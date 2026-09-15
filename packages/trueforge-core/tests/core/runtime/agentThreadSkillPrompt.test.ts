/**
 * Track 2 routing through the real instruction assembly: a thread built with a
 * sandbox whose mounter carries skills must emit a <skills> section with the
 * MUST-prefer guidance; a thread with no sandbox must not emit one at all.
 * (AgentThread.ts itself is untouched — this pins the behavior at its seam.)
 */
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { Sandbox } from '../../../src/core/sandbox/Sandbox';
import { SkillMounter, type GitSkill } from '../../../src/core/sandbox/skills/SkillMounter';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger, makeStubPublicSandbox } from '../harnessMocks';

const GIT_SKILL = {
  type: 'git',
  name: 'git-skill',
  description: 'From git',
  url: 'https://github.com/acme/skills.git',
  path: '',
  ref: 'a'.repeat(40),
  when_to_use: ['summarize a long document'],
} satisfies GitSkill;

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* finalAnswerStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  yield {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: 'done' }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

async function firstSystemMessage(sandbox: Sandbox | undefined): Promise<string | undefined> {
  const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: { modelId: undefined, configuredModels: undefined, modelClient, instruction: 'test', toolSets: [] },
    context: [{ role: 'user', content: 'Summarize this document.' }],
    sandbox,
  });

  for await (const _event of thread.execute({ signal: new AbortController().signal })) {
    // Draining is enough; the assertion is on the request sent to the model.
  }

  const request = create.mock.calls[0]?.[0];
  const systemMessage = request?.messages.find(m => m.role === 'system');
  return typeof systemMessage?.content === 'string' ? systemMessage.content : undefined;
}

describe('AgentThread skill prompt section', () => {
  it('renders <skills> with precedence guidance when the sandbox mounts skills', async () => {
    const sandbox = makeStubPublicSandbox({ skillMounter: new SkillMounter([GIT_SKILL]) });
    const system = await firstSystemMessage(sandbox);

    expect(system).toContain('<skills>');
    expect(system).toContain('MUST use that skill');
    expect(system).toContain('MUST NOT substitute generic exec/file/MCP/web tools');
    expect(system).toContain('git-skill');
    expect(system).toContain('when_to_use:');
    expect(system).toContain('- summarize a long document');
  });

  it('renders no <skills> section when there is no sandbox', async () => {
    const system = await firstSystemMessage(undefined);

    expect(system).toBeDefined();
    expect(system).not.toContain('<skills>');
  });
});
