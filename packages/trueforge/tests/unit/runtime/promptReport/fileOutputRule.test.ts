/**
 * A file the model makes reaches the person only through a sandbox_artifacts block. The guidance
 * waits behind load_bundle, so the rule must go out with the tools that make files, on the first
 * request of a chat with no repository bound and file downloads on.
 */
import { AgentThread } from '@truefoundry/trueforge-core/core';
import type { ILLM, LLMCreateParamsStreaming } from '@truefoundry/trueforge-core/core/llm/ILLM';
import {
  getEmptyUsage,
  type ExtendedChatCompletionChunk,
  type RawAssistantMessageWithUsage,
} from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { createLogger } from 'winston';
import { buildPersonalInstance } from '../../../../src/runtime/promptReport/personalInstance';

async function* answer(
  text: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  await Promise.resolve();
  yield {
    id: 'chunk-answer',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'scripted',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: text }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

async function firstRequest(): Promise<LLMCreateParamsStreaming> {
  const instance = await buildPersonalInstance({ name: 'personal', googleAccess: 'read', sentinelServices: undefined });
  if (instance.sandbox?.getBoundRepositoryContext() !== undefined) {
    throw new Error('expected a chat with no repository bound');
  }
  const requests: LLMCreateParamsStreaming[] = [];
  const modelClient: ILLM = {
    create: jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      return answer('Done.');
    }),
    createNonStream: jest.fn(),
  };
  const thread = new AgentThread({
    definition: { ...instance.definition, modelClient },
    threadId: 'main',
    title: 'Main',
    turnToolCallLedger: undefined,
    sandbox: instance.sandbox,
    capabilities: instance.capabilities,
    context: [{ role: 'user', content: 'Make a CSV of these numbers and give it to me: 1, 2, 3.' }],
    capabilityState: undefined,
    sentinel: instance.sentinel,
    toolCallMemo: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: createLogger({ silent: true }),
  });
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    void event;
  }
  const [request] = requests;
  if (request === undefined) {
    throw new Error('expected a model request');
  }
  return request;
}

describe('the file output rule goes out with the tools that make files', () => {
  it('names sandbox_artifacts in the exec and write_file descriptions of the first request', async () => {
    const request = await firstRequest();
    const descriptions = new Map(
      (request.tools ?? []).flatMap(tool =>
        tool.type === 'function' ? [[tool.function.name, tool.function.description ?? '']] : [],
      ),
    );
    expect(descriptions.get('exec')).toContain('sandbox_artifacts');
    expect(descriptions.get('write_file')).toContain('sandbox_artifacts');
  });
});
