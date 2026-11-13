import { AgentThread } from '@truefoundry/trueforge-core/core';
import type { GoogleConnectionStore } from '@truefoundry/trueforge-core/core/google/connection';
import type { ILLM, LLMCreateParamsStreaming } from '@truefoundry/trueforge-core/core/llm/ILLM';
import {
  getEmptyUsage,
  type ExtendedChatCompletionChunk,
  type RawAssistantMessageWithUsage,
} from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { createLogger } from 'winston';
import { googleSetupCapability } from '../../../src/runtime/googleSetupCapability';
import { buildPersonalInstance } from '../../../src/runtime/promptReport/personalInstance';

const OWNER = { tenant_id: 'prompt-report', created_by: 'prompt-report-user' };

/** A person who never connected Google: the case where the main chat mounts the Google setup read. */
const NO_GOOGLE_LOGIN: GoogleConnectionStore = {
  get: () => Promise.resolve(null),
  save: () => Promise.reject(new Error('unused in this test')),
  markNeedsReconnect: () => Promise.reject(new Error('unused in this test')),
  setAccountEmail: () => Promise.reject(new Error('unused in this test')),
  delete: () => Promise.reject(new Error('unused in this test')),
};

async function* answer(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const text = 'Open Settings, then Connectors.';
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

/** What a guide turn sends the model when the person asks about email, with the main chat's setup mounted. */
async function sentFor({ readOnly }: { readOnly: boolean }): Promise<string> {
  const instance = await buildPersonalInstance({
    name: 'personal-with-google',
    googleAccess: 'read',
    sentinelServices: undefined,
  });
  const setup = await googleSetupCapability({
    connections: NO_GOOGLE_LOGIN,
    owner: OWNER,
    tracing: NOOP_AGENT_TRACING,
  });
  const requests: LLMCreateParamsStreaming[] = [];
  const modelClient: ILLM = {
    create: jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      return answer();
    }),
    createNonStream: jest.fn(),
  };
  const thread = new AgentThread({
    definition: { ...instance.definition, modelClient, readOnly },
    threadId: 'main',
    title: 'Main',
    turnToolCallLedger: undefined,
    sandbox: instance.sandbox,
    capabilities: [...instance.capabilities, ...(setup === undefined ? [] : [setup])],
    context: [{ role: 'user', content: 'Connecting email or calendar' }],
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
  expect(requests.length).toBeGreaterThan(0);
  return JSON.stringify(requests);
}

describe('a read-only guide turn inside a normal chat', () => {
  beforeAll(() => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in tests.'));
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('carries none of the main chat setup instructions, Google or otherwise', async () => {
    const sent = await sentFor({ readOnly: true });

    expect(sent).not.toContain('google_setup_status');
    expect(sent).not.toContain('console.cloud.google.com');
    for (const name of ['create_schedule', 'create_space', 'create_sub_agent', 'get_openui_instructions']) {
      expect(sent).not.toContain(name);
    }
  });

  it('keeps them for the main chat itself, so the check above is not vacuous', async () => {
    const sent = await sentFor({ readOnly: false });

    for (const name of ['google_setup_status', 'create_schedule', 'create_space', 'create_sub_agent']) {
      expect(sent).toContain(name);
    }
    // The Cloud steps are the setup read's answer, never the chat's standing instructions.
    expect(sent).not.toContain('console.cloud.google.com');
  });
});
