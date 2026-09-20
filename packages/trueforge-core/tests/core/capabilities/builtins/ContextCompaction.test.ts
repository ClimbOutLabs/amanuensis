import { z } from 'zod';
import type { AgentThreadExecutionContext } from '../../../../src/core/capabilities/AgentContextProcessor';
import {
  contextCompaction,
  contextUsesSandboxTools,
  CONVERSATION_REQUIRED_SUMMARY_SECTIONS,
  DEFAULT_CONTEXT_COMPACTION_THRESHOLD_TOKENS,
  replaceBoundRepositorySection,
  REQUIRED_SUMMARY_SECTIONS,
  resolveCompactionThresholdTokens,
  validateCompactionSummary,
} from '../../../../src/core/capabilities/builtins/ContextCompaction';
import { repositoryBindingContext } from '../../../../src/core/capabilities/builtins/RepositoryBindingContext';
import type { TaskChecklistAccess } from '../../../../src/core/capabilities/builtins/TaskChecklist';
import { createToolResponseV2, newEventId, type ToolResultDisposition } from '../../../../src/core/events/schema';
import type { InternalEnrichedToolCall, InternalToolCallInfo } from '../../../../src/core/llm/LLMTypes';
import {
  getEmptyUsage,
  type ExtendedChatCompletionChunk,
  type RawAssistantMessageWithUsage,
} from '../../../../src/core/llm/LLMTypes';
import type { AgentDefinition } from '../../../../src/core/runtime/AgentDefinition';
import { AgentThread } from '../../../../src/core/runtime/AgentThread';
import { InternalEventType, type ContextMessage } from '../../../../src/core/runtime/AgentThread.types';
import { isLLMContextMessage, userAuthoredText } from '../../../../src/core/runtime/contextUtils';
import {
  SANDBOX_EXEC_TOOL_NAME,
  type BoundRepository,
  type BoundRepositoryContext,
} from '../../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { withTimeout } from '../../../../src/core/util/promiseUtils';
import { makeMockILLM, makeSilentLogger, makeStubPublicSandbox } from '../../harnessMocks';

/**
 * Threshold of 1 guarantees the compaction system prompt alone (~100+ tokens)
 * trips the check regardless of the (empty) context passed in — every test
 * here cares about *which model* gets called, not the threshold arithmetic.
 */
const ALWAYS_TRIGGERS_THRESHOLD = 1;

/**
 * A minimal bound repository, threaded into the coding-mode-specific tests below that predate
 * the session-mode split (see ContextCompaction.ts's CompactionSessionMode): they exercise the
 * engineering-handoff template and rely on a repository being bound (or a sandbox attached) to
 * select coding mode, just as they did before the split existed.
 */
const STUB_BOUND_REPOSITORY: BoundRepository = {
  repository_id: 'stub-repository',
  revision: 1,
  workspace_cwd: '/repo',
  commands: [],
};

async function* finalAnswerStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  await Promise.resolve();
  yield {
    id: 'chunk-final',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'continued' }, finish_reason: 'stop' }],
  };
  return {
    output: { role: 'assistant', content: 'continued' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

function makeExecution(context: ContextMessage[] = []): AgentThreadExecutionContext {
  return {
    threadId: 'main',
    signal: undefined,
    currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
    context,
  };
}

async function drainProcessPreLLM(
  capability: ReturnType<typeof contextCompaction>,
  context: ContextMessage[] = [],
): Promise<void> {
  const processor = capability.preLLMProcessors?.[0];
  if (!processor) {
    throw new Error('expected a preLLMProcessor');
  }
  for await (const _event of processor.processPreLLM(makeExecution(context))) {
    // draining triggers the summarization call; the event content isn't under test here
  }
}

async function collectProcessPreLLM(capability: ReturnType<typeof contextCompaction>, context: ContextMessage[] = []) {
  const processor = capability.preLLMProcessors?.[0];
  if (processor === undefined) {
    throw new Error('expected a preLLMProcessor');
  }
  const events = [];
  for await (const event of processor.processPreLLM(makeExecution(context))) {
    events.push(event);
  }
  return events;
}

function successfulStructuredEdits(): ContextMessage[] {
  const replaceCallId = 'replace-call';
  const patchCallId = 'patch-call';
  const writeCallId = 'write-call';
  const deniedCallId = 'denied-call';
  const failedCallId = 'failed-call';
  const legacyCallId = 'legacy-call';
  const scopedCall = (toolCallId: string, originalToolName: string, paths: string[]): InternalEnrichedToolCall => {
    const toolInfo: InternalToolCallInfo = {
      type: 'truefoundry-system',
      mcp_server_id: 'sandbox',
      mcp_server_name: 'Sandbox',
      original_tool_name: originalToolName,
      is_approval_required: true,
      effect: 'edit',
    };
    Reflect.set(toolInfo, 'implementation_plan_scope', { touched_paths: paths });
    return {
      id: toolCallId,
      type: 'function',
      function: { name: `sandbox__${originalToolName}`, arguments: '{}' },
      tool_info: toolInfo,
    };
  };
  const terminalResult = (toolCallId: string, disposition: ToolResultDisposition) =>
    createToolResponseV2({
      id: newEventId(),
      thread_id: 'main',
      tool_call_id: toolCallId,
      created_at: new Date().toISOString(),
      raw_content: JSON.stringify({ status: 'saved' }),
      model_content: null,
      screen: null,
      admission_provenance: { source: 'internal' },
      memoized: false,
      repeat_count: 1,
      disposition,
      remediation: undefined,
    }).model_message;
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        scopedCall(replaceCallId, 'replace_text:edit', ['packages/core/src/first.ts']),
        scopedCall(patchCallId, 'apply_patch:edit', ['packages/core/src/second.ts', 'docs/continuity.md']),
        scopedCall(writeCallId, 'write_file:edit', ['packages/core/src/future-write.ts']),
        scopedCall(deniedCallId, 'replace_text:edit', ['packages/core/src/denied.ts']),
        scopedCall(failedCallId, 'apply_patch:edit', ['packages/core/src/failed.ts']),
        scopedCall(legacyCallId, 'apply_patch:edit', ['packages/core/src/legacy-result.ts']),
      ],
    },
    terminalResult(replaceCallId, 'executed_ok'),
    terminalResult(patchCallId, 'executed_ok'),
    terminalResult(writeCallId, 'executed_ok'),
    terminalResult(deniedCallId, 'denied'),
    terminalResult(failedCallId, 'executed_nonzero'),
    { role: 'tool', tool_call_id: legacyCallId, content: JSON.stringify({ status: 'ok' }) },
  ];
}

function completedSummary(boundRepositoryState: string): string {
  return `<summary>
## goal
Resume the approved coding task and preserve its constraints.
## done_so_far
Completed the focused compaction implementation.
## user_request
Continue with the next step of the implementation.
## workspace
/repo cloned from git@github.com:example/project.git on branch main.
## findings
- src/ContextCompaction.ts: compaction logic implementation
- tests/ContextCompaction.test.ts: unit tests for compaction
## in_flight_work
Writing focused tests.
## remaining_work
Run the focused test suite, then perform the next verification step.
## current_blocker
none
## bound_repository_state
${boundRepositoryState}
</summary>`;
}

describe('contextCompaction model role', () => {
  it('inherits the thread model when auxiliary_models.compaction is unset — same client object, not a re-resolved copy', async () => {
    const threadModelClient = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('model-state') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const definition: AgentDefinition = {
      modelId: undefined,
      configuredModels: undefined,
      modelClient: threadModelClient,
    };

    const capability = contextCompaction({
      logger: undefined,
      definition,
      compactionModel: undefined,
      boundRepository: STUB_BOUND_REPOSITORY,
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
    });
    await drainProcessPreLLM(capability);

    expect(threadModelClient.createNonStream).toHaveBeenCalledTimes(1);
  });

  it('uses the configured compaction model instead of the thread model when auxiliary_models.compaction is set', async () => {
    const threadModelClient = makeMockILLM();
    const compactionModelClient = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('model-state') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const definition: AgentDefinition = {
      modelId: undefined,
      configuredModels: undefined,
      modelClient: threadModelClient,
    };

    const capability = contextCompaction({
      logger: undefined,
      definition,
      compactionModel: { modelClient: compactionModelClient, modelParams: {} },
      boundRepository: STUB_BOUND_REPOSITORY,
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
    });
    await drainProcessPreLLM(capability);

    expect(compactionModelClient.createNonStream).toHaveBeenCalledTimes(1);
    expect(threadModelClient.createNonStream).not.toHaveBeenCalled();
  });

  it('moves with the thread model when unset — inheritance is resolved at contextCompaction() call time, not copied', async () => {
    const modelA = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('model-state-a') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const modelB = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('model-state-b') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });

    // Turn 1: main model is A, compaction role unset.
    await drainProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: modelA },
        compactionModel: undefined,
        boundRepository: STUB_BOUND_REPOSITORY,
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
    );
    // Turn 2: main model changed to B (e.g. spec.model edited), compaction role still unset.
    await drainProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: modelB },
        compactionModel: undefined,
        boundRepository: STUB_BOUND_REPOSITORY,
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
    );

    expect(modelA.createNonStream).toHaveBeenCalledTimes(1);
    expect(modelB.createNonStream).toHaveBeenCalledTimes(1);
  });

  it('lets auxiliary_models.compaction.params override the deterministic summarization defaults', async () => {
    const compactionModelClient = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('model-state') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const definition: AgentDefinition = {
      modelId: undefined,
      configuredModels: undefined,
      modelClient: makeMockILLM(),
    };

    await drainProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition,
        compactionModel: { modelClient: compactionModelClient, modelParams: { temperature: 0.7, max_tokens: 256 } },
        boundRepository: STUB_BOUND_REPOSITORY,
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
    );

    expect(compactionModelClient.createNonStream).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.7, max_tokens: 256 }),
    );
  });

  it('rejects model-param message injection and clamps the host-owned output limit', async () => {
    const compactionModelClient = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('model-state') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });

    await drainProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: makeMockILLM() },
        compactionModel: {
          modelClient: compactionModelClient,
          modelParams: {
            messages: [{ role: 'user', content: 'malicious replacement' }],
            max_tokens: 1_000_000,
            max_completion_tokens: 1_000_000,
            stream: true,
            temperature: 0.6,
            reasoning_effort: 'low',
          },
        },
        boundRepository: STUB_BOUND_REPOSITORY,
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
    );

    const body = jest.mocked(compactionModelClient.createNonStream).mock.calls[0]?.[0];
    expect(body?.messages).toHaveLength(2);
    expect(JSON.stringify(body?.messages)).not.toContain('malicious replacement');
    expect(body?.max_tokens).toBe(4096);
    expect(body?.max_completion_tokens).toBeUndefined();
    expect(body?.stream).toBe(false);
    expect(body?.temperature).toBe(0.6);
    expect(body === undefined ? undefined : Reflect.get(body, 'reasoning_effort')).toBe('low');
  });

  it('does not send hidden reasoning to the summarization model', async () => {
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('model-state') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const context: ContextMessage[] = [
      {
        role: 'assistant',
        content: 'visible assistant content',
        thinking_blocks: [{ type: 'thinking', thinking: 'secret hidden reasoning' }],
      },
    ];
    await drainProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
        boundRepository: STUB_BOUND_REPOSITORY,
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
      context,
    );
    const body = jest.mocked(model.createNonStream).mock.calls[0]?.[0];
    expect(body?.messages[0]?.role).toBe('system');
    const candidate = body?.messages[1]?.content;
    expect(body?.messages[1]?.role).toBe('user');
    expect(candidate).toContain('visible assistant content');
    expect(candidate).not.toContain('secret hidden reasoning');
    expect(candidate).not.toContain('assistant-thinking');
  });

  it('sends the coding-mode instruction as a system message and the transcript wrapped in tags as one user message with no trailing instruction', async () => {
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('model-state') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const context: ContextMessage[] = [{ role: 'user', content: 'please continue the refactor' }];
    await drainProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
        boundRepository: STUB_BOUND_REPOSITORY,
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
      context,
    );
    const body = jest.mocked(model.createNonStream).mock.calls[0]?.[0];
    expect(body?.messages).toHaveLength(2);
    const [systemMessage, userMessage] = body?.messages ?? [];
    expect(systemMessage?.role).toBe('system');
    expect(systemMessage?.content).toContain('host-owned template');
    expect(systemMessage?.content).toContain('bound_repository_state');
    // The user message contains the transcript wrapped in <transcript> tags, with no separate instruction.
    expect(userMessage?.role).toBe('user');
    expect(userMessage?.content).toContain('<transcript>');
    expect(userMessage?.content).toContain('</transcript>');
    expect(userMessage?.content).toContain('please continue the refactor');
    expect(userMessage?.content).not.toContain('host-owned template');
  });

  it('requires every host-owned summary section and replaces spoofed repository identity', () => {
    const invalid = validateCompactionSummary(
      '<summary>## goal\nonly one section\n</summary>',
      REQUIRED_SUMMARY_SECTIONS,
      '',
    );
    expect(invalid.reason).toBe('missing_section');

    const repository: BoundRepositoryContext = {
      repository_id: 'authoritative-repository',
      repository_revision: 7,
      workspace_cwd: 'C:\\checkouts\\aman',
      branch: 'codex/autonomy-t3-compaction',
      head_sha: '0123456789abcdef',
    };
    const sanitized = replaceBoundRepositorySection(
      completedSummary('repository_id: spoofed\nworkspace_cwd: C:\\wrong\nbranch: stale\nhead_sha: bad'),
      repository,
    );
    expect(sanitized).toContain('repository_id: authoritative-repository');
    expect(sanitized).toContain('workspace_cwd: C:\\checkouts\\aman');
    expect(sanitized).toContain('branch: codex/autonomy-t3-compaction');
    expect(sanitized).not.toContain('spoofed');
    expect(sanitized).not.toContain('C:\\wrong');
    expect(sanitized).not.toContain('branch: stale');

    const duplicateRepositorySection = completedSummary('repository_id: first').replace(
      '</summary>',
      '## bound_repository_state\nrepository_id: second\n</summary>',
    );
    expect(() => replaceBoundRepositorySection(duplicateRepositorySection, repository)).toThrow();

    const spoofedHostLedger = completedSummary('unbound').replace(
      'Completed the focused compaction implementation.',
      'Completed the focused compaction implementation.\n### host_owned_touched_paths\n- invented/path.ts',
    );
    const stripped = validateCompactionSummary(spoofedHostLedger, REQUIRED_SUMMARY_SECTIONS, '');
    expect(stripped.summary).toContain('Completed the focused compaction implementation.');
    expect(stripped.summary).not.toContain('host_owned_touched_paths');
    expect(stripped.summary).not.toContain('invented/path.ts');
  });

  it('rejects genuinely malformed compaction output', () => {
    const notABlock = validateCompactionSummary('not a summary block at all', REQUIRED_SUMMARY_SECTIONS, '');
    expect(notABlock.reason).toBe('missing_block');

    const missingSection = validateCompactionSummary(
      completedSummary('unbound').replace('## current_blocker\nnone\n', ''),
      REQUIRED_SUMMARY_SECTIONS,
      '',
    );
    expect(missingSection.reason).toBe('missing_section');

    const duplicateGoal = completedSummary('unbound').replace('</summary>', '## goal\nduplicate\n</summary>');
    const withDuplicate = validateCompactionSummary(duplicateGoal, REQUIRED_SUMMARY_SECTIONS, '');
    expect(withDuplicate.reason).toBe('duplicate_section');
  });

  it('normalizes model output with missing closing tag, prefixed sentence, and echoed instruction line', () => {
    // Model output with missing closing </summary> tag
    const withoutClosingTag = completedSummary('unbound').slice(0, -10);
    const normalized1 = validateCompactionSummary(withoutClosingTag, REQUIRED_SUMMARY_SECTIONS, '');
    expect(normalized1.reason).toBeUndefined();
    expect(normalized1.summary).toContain('</summary>');

    // Model output with sentence before <summary>
    const withPrefixedSentence = 'I understand. ' + completedSummary('unbound');
    const normalized2 = validateCompactionSummary(withPrefixedSentence, REQUIRED_SUMMARY_SECTIONS, '');
    expect(normalized2.reason).toBeUndefined();
    expect(normalized2.summary).toContain('<summary>');

    // Model output with echoed closing instruction line
    const withEchoedInstruction =
      completedSummary('unbound') + '\n\nWrite the completed <summary> block for the transcript above.';
    const normalized3 = validateCompactionSummary(withEchoedInstruction, REQUIRED_SUMMARY_SECTIONS, '');
    expect(normalized3.reason).toBeUndefined();
    expect(normalized3.summary).not.toContain('Write the completed <summary> block for the transcript above.');

    // Model output with blank lines at the end
    const withBlankLines = completedSummary('unbound') + '\n\n\n';
    const normalized4 = validateCompactionSummary(withBlankLines, REQUIRED_SUMMARY_SECTIONS, '');
    expect(normalized4.reason).toBeUndefined();
  });

  it('accepts a coding-mode goal that describes the user objective, and rejects one that describes the summarization request itself', () => {
    const valid = validateCompactionSummary(completedSummary('unbound'), REQUIRED_SUMMARY_SECTIONS, '');
    expect(valid.reason).toBeUndefined();

    const selfReferentialGoal = completedSummary('unbound').replace(
      'Resume the approved coding task and preserve its constraints.',
      'Produce a concise engineering handoff that captures the current user objective and constraints. Use the host-owned template.',
    );
    const selfRef = validateCompactionSummary(selfReferentialGoal, REQUIRED_SUMMARY_SECTIONS, '');
    expect(selfRef.reason).toBe('self_referential');

    const summarizationRequestGoal = completedSummary('unbound').replace(
      'Resume the approved coding task and preserve its constraints.',
      'Respond to this summarization request rather than the actual task.',
    );
    const sumRequest = validateCompactionSummary(summarizationRequestGoal, REQUIRED_SUMMARY_SECTIONS, '');
    expect(sumRequest.reason).toBe('self_referential');
  });

  it('accepts a coding-mode goal containing a flagged phrase when the user actually used that phrase in the transcript', () => {
    const goalWithPhrase = completedSummary('unbound').replace(
      'Resume the approved coding task and preserve its constraints.',
      'Complete the engineering handoff to the next team and document the process.',
    );
    const transcriptWithPhrase = '<0><user>:I need to do an engineering handoff to document the current work.';
    const withPhrase = validateCompactionSummary(goalWithPhrase, REQUIRED_SUMMARY_SECTIONS, transcriptWithPhrase);
    expect(withPhrase.reason).toBeUndefined();

    const transcriptWithoutPhrase = '<0><user>:I need to hand off my work to the next team.';
    const withoutPhrase = validateCompactionSummary(goalWithPhrase, REQUIRED_SUMMARY_SECTIONS, transcriptWithoutPhrase);
    expect(withoutPhrase.reason).toBe('self_referential');
  });

  it('rejects a self-referential goal even when the guarded phrase appears only in an earlier assistant reply, not in anything the user wrote', () => {
    // Mirrors the observed defect: the assistant echoed the host's handoff instruction back to the
    // user in an earlier reply, and the goal section then copies that instruction rather than the
    // user's actual objective. The guarded phrase must be excused only when the user wrote it, so
    // this must still be rejected even though the phrase is present somewhere in the conversation.
    const context: ContextMessage[] = [
      { role: 'user', content: 'Please keep working on the refactor.' },
      {
        role: 'assistant',
        content: 'Sure — here is the host-owned template for the engineering handoff you requested.',
      },
    ];
    const userText = userAuthoredText(context);
    expect(userText).not.toContain('engineering handoff');

    const selfReferentialGoal = completedSummary('unbound').replace(
      'Resume the approved coding task and preserve its constraints.',
      'Produce a concise engineering handoff that captures the current user objective and constraints. Use the host-owned template.',
    );
    const result = validateCompactionSummary(selfReferentialGoal, REQUIRED_SUMMARY_SECTIONS, userText);
    expect(result.reason).toBe('self_referential');
  });

  it('accepts a conversation-mode user_goal that describes the user objective, and rejects one that describes an engineering handoff', () => {
    const valid = validateCompactionSummary(
      completedConversationSummary('What is the weather like in Kyoto?'),
      CONVERSATION_REQUIRED_SUMMARY_SECTIONS,
      '',
    );
    expect(valid.reason).toBeUndefined();

    const selfReferentialUserGoal = completedConversationSummary('What is the weather like in Kyoto?').replace(
      'Get help planning a trip to Kyoto.',
      'Produce a concise engineering handoff for the host template.',
    );
    const result = validateCompactionSummary(selfReferentialUserGoal, CONVERSATION_REQUIRED_SUMMARY_SECTIONS, '');
    expect(result.reason).toBe('self_referential');
  });

  it('strips a model-copied host_owned_touched_paths subsection instead of rejecting the summary, and appends exactly one authoritative copy', async () => {
    const copiedSubsection = completedSummary('unbound').replace(
      'Completed the focused compaction implementation.',
      'Completed the focused compaction implementation.\n### host_owned_touched_paths\nstatus: complete\noverflowed: false\ntotal_observed_path_count: 1\n- stale/copied-path.ts\n',
    );
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: copiedSubsection },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const events = await collectProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
        boundRepository: STUB_BOUND_REPOSITORY,
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
    );
    const overwrite = events.find(event => event.type === 'agent.context.overwrite');
    if (overwrite === undefined || overwrite.type !== 'agent.context.overwrite') {
      throw new Error('expected compaction overwrite');
    }
    const persisted = JSON.stringify(overwrite.context);
    expect(persisted.split('### host_owned_touched_paths').length - 1).toBe(1);
    expect(persisted).not.toContain('stale/copied-path.ts');
    expect(persisted).toContain('total_observed_path_count: 0');
    expect(persisted).toContain('- none');
  });

  it('degrades gracefully on malformed compaction output: no overwrite, no thrown error, compaction is skipped', async () => {
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: 'not a valid summary block' },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const events = await collectProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
    );
    expect(events.find(event => event.type === 'agent.context.overwrite')).toBeUndefined();
    const usageEvent = events.find(event => event.type === InternalEventType.MODEL_USAGE);
    if (usageEvent === undefined || usageEvent.type !== InternalEventType.MODEL_USAGE) {
      throw new Error('expected a MODEL_USAGE event for the discarded compaction request');
    }
    expect(usageEvent.usage).toEqual({ input_tokens: 1, output_tokens: 1, total_tokens: 2 });
  });

  it('folds a discarded compaction request usage into thread billable metrics without overwriting context or counting a summarization', async () => {
    const model = makeMockILLM({
      create: jest.fn(() => finalAnswerStream()),
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: 'not a valid summary block' },
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
        finish_reason: 'stop',
      }),
    });
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      sandbox: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model, toolSets: [] },
      context: [{ role: 'user', content: 'continue without a fresh greeting' }],
      capabilities: [
        contextCompaction({
          logger: undefined,
          definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
          compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
        }),
      ],
    });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Drain the discarded compaction attempt and the ordinary model request.
    }

    const metrics = thread.getAgentThreadMetrics();
    expect(metrics.total_input_tokens).toBeGreaterThanOrEqual(11);
    expect(metrics.total_output_tokens).toBeGreaterThanOrEqual(7);
    expect(metrics.total_summarizations).toBe(0);
    expect(JSON.stringify(thread.toSnapshot().context)).not.toContain('not a valid summary block');
  });

  it('reinjects the authoritative T2 repository state into the persisted compaction context', async () => {
    const repository: BoundRepositoryContext = {
      repository_id: 'authoritative-repository',
      repository_revision: 8,
      workspace_cwd: 'C:\\checkouts\\aman',
      branch: 'codex/autonomy-t3-compaction',
      head_sha: 'fedcba9876543210',
    };
    const sandbox = makeStubPublicSandbox();
    jest.spyOn(sandbox, 'refreshBoundRepositoryState').mockResolvedValue(undefined);
    jest.spyOn(sandbox, 'getBoundRepositoryContext').mockReturnValue(repository);
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: {
          role: 'assistant',
          content: completedSummary('repository_id: spoofed\nbranch: wrong\nhead_sha: wrong'),
        },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const capability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      // Coding mode is selected on evidence (bound repository here), not merely on the sandbox
      // being attached; this test is about repository-state reinjection, not mode selection.
      boundRepository: STUB_BOUND_REPOSITORY,
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
    });
    const processor = capability.preLLMProcessors?.[0];
    if (processor === undefined) throw new Error('expected a preLLMProcessor');
    const events = [];
    for await (const event of processor.processPreLLM({ ...makeExecution(), sandbox })) events.push(event);
    const overwrite = events[0];
    if (!overwrite || overwrite.type !== 'agent.context.overwrite') throw new Error('expected compaction overwrite');
    const persisted = JSON.stringify(overwrite.context);
    expect(persisted).toContain('repository_id: authoritative-repository');
    expect(persisted).toContain('repository_revision: 8');
    expect(persisted).toContain('branch: codex/autonomy-t3-compaction');
    expect(persisted).toContain('head_sha: fedcba9876543210');
    expect(persisted).not.toContain('spoofed');
    expect(persisted).not.toContain('branch: wrong');
    expect(persisted).not.toContain('Host-bound repository state (authoritative');
  });

  it('refreshes repository state immediately before the compaction model request', async () => {
    const staleRepository: BoundRepositoryContext = {
      repository_id: 'repository-1',
      repository_revision: 8,
      workspace_cwd: '/repo',
      branch: 'codex/stale',
      head_sha: '1111111111111111',
    };
    const freshRepository: BoundRepositoryContext = {
      ...staleRepository,
      branch: 'codex/fresh',
      head_sha: '2222222222222222',
    };
    const sandbox = makeStubPublicSandbox();
    let providerRepository = staleRepository;
    let observedRepository = staleRepository;
    const refresh = jest.spyOn(sandbox, 'refreshBoundRepositoryState').mockImplementation(options => {
      expect(options).toEqual({ signal: undefined });
      observedRepository = providerRepository;
      return Promise.resolve();
    });
    jest.spyOn(sandbox, 'getBoundRepositoryContext').mockImplementation(() => observedRepository);
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('repository_id: stale-model-copy') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const capability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      // Coding mode is selected on evidence (bound repository here), not merely on the sandbox
      // being attached; this test is about repository-state freshness, not mode selection.
      boundRepository: STUB_BOUND_REPOSITORY,
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
    });
    const processor = capability.preLLMProcessors?.[0];
    if (processor === undefined) throw new Error('expected a preLLMProcessor');

    await sandbox.refreshBoundRepositoryState({ signal: undefined });
    expect(sandbox.getBoundRepositoryContext()).toEqual(staleRepository);
    providerRepository = freshRepository;
    for await (const _event of processor.processPreLLM({ ...makeExecution(), sandbox })) {
      // Drain the compaction request.
    }

    const request = jest.mocked(model.createNonStream).mock.calls[0]?.[0];
    const serializedMessages = JSON.stringify(request?.messages);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(serializedMessages).toContain('branch: codex/fresh');
    expect(serializedMessages).toContain('head_sha: 2222222222222222');
    expect(serializedMessages).not.toContain('branch: codex/stale');
    expect(serializedMessages).not.toContain('head_sha: 1111111111111111');
  });

  it('cancels a blocked compaction model request at the preLLM boundary', async () => {
    const requestStarted = Promise.withResolvers<void>();
    const model = makeMockILLM({
      createNonStream: jest.fn(() => {
        requestStarted.resolve();
        return new Promise(() => undefined);
      }),
    });
    const capability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
    });
    const processor = capability.preLLMProcessors?.[0];
    if (processor === undefined) throw new Error('expected a preLLMProcessor');
    const controller = new AbortController();
    const processing = (async () => {
      for await (const _event of processor.processPreLLM({
        ...makeExecution(),
        signal: controller.signal,
      })) {
        // The blocked request must not yield a compaction event.
      }
    })();

    await withTimeout(requestStarted.promise, 500, 'compaction request start');
    controller.abort(new Error('cancel compaction request'));

    await expect(withTimeout(processing, 500, 'compaction request cancellation')).rejects.toThrow(
      'cancel compaction request',
    );
  });

  it('uses a resolved repository binding when compaction runs without a sandbox capability', async () => {
    const boundRepository: BoundRepository = {
      repository_id: 'bound-without-sandbox',
      revision: 11,
      workspace_cwd: 'C:\\checkouts\\no-sandbox',
      commands: [],
    };
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('unbound') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const capability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      boundRepository,
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
    });
    const processor = capability.preLLMProcessors?.[0];
    if (processor === undefined) throw new Error('expected a preLLMProcessor');
    const events = [];
    for await (const event of processor.processPreLLM(makeExecution())) events.push(event);
    const overwrite = events[0];
    if (!overwrite || overwrite.type !== 'agent.context.overwrite') throw new Error('expected compaction overwrite');
    const persisted = JSON.stringify(overwrite.context);
    expect(persisted).toContain('repository_id: bound-without-sandbox');
    expect(persisted).toContain('repository_revision: 11');
    expect(persisted).toContain('workspace_cwd: C:\\\\checkouts\\\\no-sandbox');
    expect(persisted).not.toContain('repository state: unbound');
  });

  it('keeps refreshed Sandbox binding as the sole repository owner in the forced-compaction request', async () => {
    const boundRepository: BoundRepository = {
      repository_id: 'sandbox-bound-repository',
      revision: 14,
      workspace_cwd: '/repo',
      commands: [{ command_id: 'verify', purpose: 'verify', command: 'pnpm verify', timeout_ms: 900_000 }],
    };
    const sandbox = makeStubPublicSandbox();
    jest.spyOn(sandbox, 'refreshBoundRepositoryState').mockResolvedValue(undefined);
    jest.spyOn(sandbox, 'getBoundRepositoryContext').mockReturnValue({
      repository_id: boundRepository.repository_id,
      repository_revision: boundRepository.revision,
      workspace_cwd: boundRepository.workspace_cwd,
      branch: 'codex/refreshed',
      head_sha: '0123456789abcdef',
    });
    jest.spyOn(sandbox, 'buildInstruction').mockImplementation(builder => {
      builder.addSection(
        'sandbox-bound-repository',
        'repository_id: sandbox-bound-repository\nbranch: codex/refreshed\nhead_sha: 0123456789abcdef',
      );
    });
    const model = makeMockILLM({
      create: jest.fn(() => finalAnswerStream()),
      createNonStream: jest.fn().mockResolvedValue({
        output: {
          role: 'assistant',
          content: completedSummary('repository_id: spoofed\nbranch: stale\nhead_sha: stale'),
        },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      sandbox,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model, toolSets: [] },
      context: [{ role: 'user', content: 'continue without a fresh greeting' }],
      capabilities: [
        repositoryBindingContext({ boundRepository, sandboxAvailable: true, checklist: undefined }),
        contextCompaction({
          logger: undefined,
          definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
          boundRepository,
          compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
        }),
      ],
    });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Drain the forced compaction and ordinary model request.
    }

    const request = jest.mocked(model.create).mock.calls[0]?.[0];
    const outgoing = JSON.stringify(request?.messages);
    expect(outgoing.split('repository_id: sandbox-bound-repository').length - 1).toBe(1);
    expect(outgoing.split('branch: codex/refreshed').length - 1).toBe(1);
    expect(outgoing.split('head_sha: 0123456789abcdef').length - 1).toBe(1);
    expect(outgoing).not.toContain('repository_id: spoofed');
    expect(outgoing).not.toContain('branch: stale');
    expect(outgoing).not.toContain('Host-bound repository state');
    expect(JSON.stringify(thread.toSnapshot().context)).not.toContain('Host-bound repository state');
  });

  it('preserves bounded completed-work notes and appends a reserved host-owned path subsection', async () => {
    const completedWork = `Implemented durable checklist CAS and restart continuity. ${'bounded '.repeat(1_200)}`;
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: {
          role: 'assistant',
          content: completedSummary('unbound').replace(
            'Completed the focused compaction implementation.',
            completedWork,
          ),
        },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const events = await collectProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
        boundRepository: STUB_BOUND_REPOSITORY,
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
    );
    const overwrite = events.find(event => event.type === 'agent.context.overwrite');
    if (overwrite === undefined || overwrite.type !== 'agent.context.overwrite') {
      throw new Error('expected compaction overwrite');
    }
    const persisted = JSON.stringify(overwrite.context);

    expect(persisted).toContain('Implemented durable checklist CAS and restart continuity.');
    expect(persisted).toContain('[completed-work summary truncated by host]');
    expect(persisted).toContain('### host_owned_touched_paths');
    expect(persisted).toContain('status: complete');
    expect(persisted).toContain('overflowed: false');
    expect(persisted).toContain('total_observed_path_count: 0');
    expect(persisted).toContain('- none');
  });

  it('strictly validates durable touched-path state and reports bounded-ledger overflow', async () => {
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('unbound') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const capability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      boundRepository: STUB_BOUND_REPOSITORY,
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
    });
    const state = capability.state;
    if (state === undefined) {
      throw new Error('expected compaction capability state');
    }

    expect(() => state.load(['legacy-array-state'])).toThrow();
    expect(() => state.load({ paths: [], overflowed: false, extra: true })).toThrow();
    expect(() => state.load({ paths: [1], overflowed: false })).toThrow();
    expect(() => state.load({ paths: ['duplicate.ts', 'duplicate.ts'], overflowed: false })).toThrow();
    expect(() => state.load({ paths: ['normalized\\path.ts'], overflowed: false })).toThrow();
    expect(() => state.load({ paths: ['too-short.ts'], overflowed: true })).toThrow();
    expect(() =>
      state.load({
        paths: Array.from({ length: 201 }, (_, index) => `overflow/path-${String(index)}.ts`),
        overflowed: true,
      }),
    ).toThrow();

    const priorPaths = Array.from({ length: 198 }, (_, index) => `prior/path-${String(index).padStart(3, '0')}.ts`);
    state.load({ paths: priorPaths, overflowed: false });
    const events = await collectProcessPreLLM(capability, successfulStructuredEdits());
    const stateEvent = events.find(event => event.type === InternalEventType.CAPABILITY_STATE);
    if (stateEvent === undefined || stateEvent.type !== InternalEventType.CAPABILITY_STATE) {
      throw new Error('expected touched-path capability state');
    }
    const persistedState = z
      .object({ paths: z.array(z.string()), overflowed: z.boolean() })
      .strict()
      .parse(stateEvent.state);
    expect(persistedState.paths).toHaveLength(200);
    expect(persistedState.paths).toEqual(expect.arrayContaining(priorPaths));
    expect(persistedState.overflowed).toBe(true);

    const overwrite = events.find(event => event.type === 'agent.context.overwrite');
    if (overwrite === undefined || overwrite.type !== 'agent.context.overwrite') {
      throw new Error('expected compaction overwrite');
    }
    const persistedSummary = JSON.stringify(overwrite.context);
    expect(persistedSummary).toContain('status: truncated');
    expect(persistedSummary).toContain('overflowed: true');
    expect(persistedSummary).toContain('retained_path_count: 200');
    expect(persistedSummary).toContain('retained_path_limit: 200');
    expect(persistedSummary).toContain('total_observed_path_count: unknown (greater than 200)');
    expect(persistedSummary).toContain('Additional host-observed paths were omitted');
  });

  it('preserves a host-owned touched-path ledger across compaction, kill, rebuild, and resume', async () => {
    const firstModel = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: {
          role: 'assistant',
          content: completedSummary('unbound')
            .replace('Completed the focused compaction implementation.', 'none')
            .replace('Run the focused test suite', 'Resume after rebuild'),
        },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const firstCapability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: firstModel },
      boundRepository: STUB_BOUND_REPOSITORY,
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
    });
    const firstEvents = await collectProcessPreLLM(firstCapability, successfulStructuredEdits());
    const compactionBody = jest.mocked(firstModel.createNonStream).mock.calls[0]?.[0];
    expect(JSON.stringify(compactionBody?.messages[1])).not.toContain('packages/core/src/future-write.ts');
    expect(JSON.stringify(compactionBody?.messages[1])).not.toContain('sandbox__write_file:edit');
    const stateEvent = firstEvents.find(event => event.type === InternalEventType.CAPABILITY_STATE);
    const firstOverwrite = firstEvents.find(event => event.type === 'agent.context.overwrite');
    if (stateEvent === undefined || stateEvent.type !== InternalEventType.CAPABILITY_STATE) {
      throw new Error('expected touched-path capability state');
    }
    if (firstOverwrite === undefined || firstOverwrite.type !== 'agent.context.overwrite') {
      throw new Error('expected compaction overwrite');
    }
    const summaryMessage = firstOverwrite.context[0];
    const summaryContent = summaryMessage && 'content' in summaryMessage ? summaryMessage.content : '';
    expect(typeof summaryContent === 'string' && summaryContent).toBeTruthy();
    expect(summaryContent).toContain('packages/core/src/first.ts');
    expect(summaryContent).toContain('packages/core/src/second.ts');
    expect(summaryContent).toContain('docs/continuity.md');
    expect(summaryContent).toContain('packages/core/src/future-write.ts');
    expect(summaryContent).not.toContain('packages/core/src/denied.ts');
    expect(summaryContent).not.toContain('packages/core/src/failed.ts');
    expect(summaryContent).not.toContain('packages/core/src/legacy-result.ts');
    expect(summaryContent).toContain('### host_owned_touched_paths');
    expect(summaryContent).toContain('status: complete');

    const resumedModel = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: {
          role: 'assistant',
          content: completedSummary('unbound').replace('Completed the focused compaction implementation.', 'none'),
        },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const resumedCapability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: resumedModel },
      boundRepository: STUB_BOUND_REPOSITORY,
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
    });
    resumedCapability.state?.load(stateEvent.state);
    const resumedEvents = await collectProcessPreLLM(resumedCapability, firstOverwrite.context);
    const resumedOverwrite = resumedEvents.find(event => event.type === 'agent.context.overwrite');
    if (resumedOverwrite === undefined || resumedOverwrite.type !== 'agent.context.overwrite') {
      throw new Error('expected resumed compaction overwrite');
    }
    const resumedPersisted = JSON.stringify(resumedOverwrite.context);
    expect(resumedPersisted).toContain('packages/core/src/first.ts');
    expect(resumedPersisted).toContain('packages/core/src/second.ts');
    expect(resumedPersisted).toContain('docs/continuity.md');
    expect(resumedPersisted).toContain('packages/core/src/future-write.ts');
    const lastMsg = resumedOverwrite.context.at(-1);
    expect(lastMsg).toBeDefined();
    expect(resumedPersisted).not.toContain('Hello');
  });
});

function completedConversationSummary(lastRequest: string): string {
  return `<summary>
## user_goal
Get help planning a trip to Kyoto.
## facts_established
The user is traveling in October (source: user message).
## answers_given
Suggested three neighborhoods to stay in.
## open_questions
Whether the user wants a day trip to Nara.
## user_preferences_and_constraints
Budget-conscious; prefers walkable neighborhoods.
## last_request
${lastRequest}
</summary>`;
}

describe('contextCompaction session mode', () => {
  it('generates and validates a conversation-mode summary with the new sections and a last_request line, with no sandbox or bound repository', async () => {
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedConversationSummary('What is the weather like in Kyoto?') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const events = await collectProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
    );
    const body = jest.mocked(model.createNonStream).mock.calls[0]?.[0];
    // No bound-repository/checklist state solicited for a conversation-mode summarization request,
    // and the prompt tells the model plainly this is a memory aid, not a document to reproduce.
    expect(JSON.stringify(body?.messages)).not.toContain('bound_repository_state');
    expect(JSON.stringify(body?.messages)).toContain('memory aid');
    expect(JSON.stringify(body?.messages)).toContain('not a document to reproduce');
    // The instruction is a system message, not a second user message, so the model does not
    // read the most recent user-role message as the instruction itself. The transcript is wrapped
    // in <transcript> tags with no separate instruction in the user message.
    expect(body?.messages).toHaveLength(2);
    expect(body?.messages[0]?.role).toBe('system');
    expect(body?.messages[0]?.content).toContain('memory aid');
    expect(body?.messages[1]?.role).toBe('user');
    expect(body?.messages[1]?.content).toContain('<transcript>');
    expect(body?.messages[1]?.content).toContain('</transcript>');

    const overwrite = events.find(event => event.type === 'agent.context.overwrite');
    if (overwrite === undefined || overwrite.type !== 'agent.context.overwrite') {
      throw new Error('expected compaction overwrite');
    }
    const persisted = JSON.stringify(overwrite.context);
    expect(persisted).toContain('user_goal');
    expect(persisted).toContain('facts_established');
    expect(persisted).toContain('answers_given');
    expect(persisted).toContain('open_questions');
    expect(persisted).toContain('user_preferences_and_constraints');
    expect(persisted).toContain('last_request');
    expect(persisted).toContain('What is the weather like in Kyoto?');
    // No coding-only sections or ledger leak into a conversation-mode summary.
    expect(persisted).not.toContain('bound_repository_state');
    expect(persisted).not.toContain('host_owned_touched_paths');

    const compactionEvent = events.find(event => event.type === 'agent.context.compaction');
    if (compactionEvent === undefined || compactionEvent.type !== 'agent.context.compaction') {
      throw new Error('expected a compaction event');
    }
    expect(compactionEvent.mode).toBe('conversation');
    expect(compactionEvent.outcome).toBe('applied');
    expect(compactionEvent.summary_chars).toBeGreaterThan(0);
  });

  it('selects coding mode when a sandbox is attached and its exec tool was actually called, with no bound repository', async () => {
    const sandbox = makeStubPublicSandbox();
    jest.spyOn(sandbox, 'refreshBoundRepositoryState').mockResolvedValue(undefined);
    jest.spyOn(sandbox, 'getBoundRepositoryContext').mockReturnValue(undefined);
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('unbound') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const capability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
    });
    const processor = capability.preLLMProcessors?.[0];
    if (processor === undefined) throw new Error('expected a preLLMProcessor');
    const context: ContextMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'exec-call',
            type: 'function',
            function: { name: SANDBOX_EXEC_TOOL_NAME, arguments: '{}' },
            tool_info: {
              type: 'truefoundry-system',
              mcp_server_id: 'sandbox',
              mcp_server_name: 'Sandbox',
              original_tool_name: `${SANDBOX_EXEC_TOOL_NAME}:invalid`,
              is_approval_required: false,
            },
          },
        ],
      },
    ];
    const events = [];
    for await (const event of processor.processPreLLM({ ...makeExecution(context), sandbox })) events.push(event);
    const overwrite = events.find(event => event.type === 'agent.context.overwrite');
    if (overwrite === undefined || overwrite.type !== 'agent.context.overwrite') {
      throw new Error('expected compaction overwrite');
    }
    expect(JSON.stringify(overwrite.context)).toContain('bound_repository_state');
    const compactionEvent = events.find(event => event.type === 'agent.context.compaction');
    if (compactionEvent === undefined || compactionEvent.type !== 'agent.context.compaction') {
      throw new Error('expected a compaction event');
    }
    expect(compactionEvent.mode).toBe('coding');
  });

  it('selects conversation mode when a sandbox is attached but never used, with no bound repository', async () => {
    const sandbox = makeStubPublicSandbox();
    jest.spyOn(sandbox, 'refreshBoundRepositoryState').mockResolvedValue(undefined);
    jest.spyOn(sandbox, 'getBoundRepositoryContext').mockReturnValue(undefined);
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedConversationSummary('What is the weather like in Kyoto?') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const capability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
    });
    const processor = capability.preLLMProcessors?.[0];
    if (processor === undefined) throw new Error('expected a preLLMProcessor');
    const events = [];
    for await (const event of processor.processPreLLM({ ...makeExecution(), sandbox })) events.push(event);
    const overwrite = events.find(event => event.type === 'agent.context.overwrite');
    if (overwrite === undefined || overwrite.type !== 'agent.context.overwrite') {
      throw new Error('expected compaction overwrite');
    }
    expect(JSON.stringify(overwrite.context)).not.toContain('bound_repository_state');
    const compactionEvent = events.find(event => event.type === 'agent.context.compaction');
    if (compactionEvent === undefined || compactionEvent.type !== 'agent.context.compaction') {
      throw new Error('expected a compaction event');
    }
    expect(compactionEvent.mode).toBe('conversation');
  });

  it('contextUsesSandboxTools finds a sandbox tool call among other assistant tool calls and ignores non-sandbox names', () => {
    expect(contextUsesSandboxTools([])).toBe(false);
    expect(
      contextUsesSandboxTools([
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'other-call',
              type: 'function',
              function: { name: 'web_search', arguments: '{}' },
              tool_info: {
                type: 'mcp',
                mcp_server_id: 'web',
                mcp_server_name: 'Web',
                original_tool_name: 'web_search',
                is_approval_required: false,
              },
            },
          ],
        },
      ]),
    ).toBe(false);
    expect(
      contextUsesSandboxTools([
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'other-call',
              type: 'function',
              function: { name: 'web_search', arguments: '{}' },
              tool_info: {
                type: 'mcp',
                mcp_server_id: 'web',
                mcp_server_name: 'Web',
                original_tool_name: 'web_search',
                is_approval_required: false,
              },
            },
            {
              id: 'exec-call',
              type: 'function',
              function: { name: SANDBOX_EXEC_TOOL_NAME, arguments: '{}' },
              tool_info: {
                type: 'truefoundry-system',
                mcp_server_id: 'sandbox',
                mcp_server_name: 'Sandbox',
                original_tool_name: `${SANDBOX_EXEC_TOOL_NAME}:invalid`,
                is_approval_required: false,
              },
            },
          ],
        },
      ]),
    ).toBe(true);
  });

  it('presents the persisted summary as a host note preceding the summary in the model request after compaction, in both modes', async () => {
    const codingModel = makeMockILLM({
      create: jest.fn(() => finalAnswerStream()),
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('unbound') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const codingThread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      sandbox: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: codingModel, toolSets: [] },
      context: [{ role: 'user', content: 'continue without a fresh greeting' }],
      capabilities: [
        contextCompaction({
          logger: undefined,
          definition: { modelId: undefined, configuredModels: undefined, modelClient: codingModel },
          boundRepository: STUB_BOUND_REPOSITORY,
          compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
        }),
      ],
    });
    for await (const _event of codingThread.execute({ signal: new AbortController().signal })) {
      // Drain the forced compaction and ordinary model request.
    }
    const codingRequest = jest.mocked(codingModel.create).mock.calls[0]?.[0];
    const codingMessages = codingRequest?.messages ?? [];
    const codingSummaryIndex = codingMessages.findIndex(
      m => typeof m.content === 'string' && m.content.includes('<summary>'),
    );
    expect(codingSummaryIndex).toBeGreaterThanOrEqual(0);
    const codingSummaryMessage = codingMessages[codingSummaryIndex];
    expect(codingSummaryMessage?.role).toBe('user');
    expect(typeof codingSummaryMessage?.content === 'string' && codingSummaryMessage.content).toContain(
      'host-written summary of earlier conversation',
    );
    const codingPrefaceIndex =
      typeof codingSummaryMessage?.content === 'string'
        ? codingSummaryMessage.content.indexOf('host-written summary of earlier conversation')
        : -1;
    const codingSummaryTagIndex =
      typeof codingSummaryMessage?.content === 'string' ? codingSummaryMessage.content.indexOf('<summary>') : -1;
    expect(codingPrefaceIndex).toBeGreaterThanOrEqual(0);
    expect(codingSummaryTagIndex).toBeGreaterThan(codingPrefaceIndex);

    const conversationModel = makeMockILLM({
      create: jest.fn(() => finalAnswerStream()),
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedConversationSummary('Where should I eat dinner?') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const conversationThread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      sandbox: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: conversationModel, toolSets: [] },
      context: [{ role: 'user', content: 'continue without a fresh greeting' }],
      capabilities: [
        contextCompaction({
          logger: undefined,
          definition: { modelId: undefined, configuredModels: undefined, modelClient: conversationModel },
          compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
        }),
      ],
    });
    for await (const _event of conversationThread.execute({ signal: new AbortController().signal })) {
      // Drain the forced compaction and ordinary model request.
    }
    const conversationRequest = jest.mocked(conversationModel.create).mock.calls[0]?.[0];
    const conversationMessages = conversationRequest?.messages ?? [];
    const conversationSummaryMessage = conversationMessages.find(
      m => typeof m.content === 'string' && m.content.includes('<summary>'),
    );
    expect(conversationSummaryMessage?.role).toBe('user');
    const conversationContent =
      typeof conversationSummaryMessage?.content === 'string' ? conversationSummaryMessage.content : '';
    const conversationPrefaceIndex = conversationContent.indexOf('host-written summary of earlier conversation');
    const conversationSummaryTagIndex = conversationContent.indexOf('<summary>');
    expect(conversationPrefaceIndex).toBeGreaterThanOrEqual(0);
    expect(conversationSummaryTagIndex).toBeGreaterThan(conversationPrefaceIndex);
    expect(conversationContent).toContain("user's own conversational register");
  });

  it('rejects a malformed conversation-mode summary without overwriting context, and emits a skipped_invalid compaction event', async () => {
    const missingSection = `<summary>
## user_goal
Plan a trip.
## facts_established
none
## answers_given
none
## open_questions
none
## user_preferences_and_constraints
none
</summary>`;
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: missingSection },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const events = await collectProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
    );
    expect(events.find(event => event.type === 'agent.context.overwrite')).toBeUndefined();
    const compactionEvent = events.find(event => event.type === 'agent.context.compaction');
    if (compactionEvent === undefined || compactionEvent.type !== 'agent.context.compaction') {
      throw new Error('expected a compaction event');
    }
    expect(compactionEvent.mode).toBe('conversation');
    expect(compactionEvent.outcome).toBe('skipped_invalid');
    expect(compactionEvent.summary_chars).toBe(0);
  });

  it('rejects an over-length conversation-mode summary without overwriting context', async () => {
    const overlong = completedConversationSummary('x'.repeat(20_000));
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: overlong },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const events = await collectProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
    );
    expect(events.find(event => event.type === 'agent.context.overwrite')).toBeUndefined();
    const compactionEvent = events.find(event => event.type === 'agent.context.compaction');
    if (compactionEvent === undefined || compactionEvent.type !== 'agent.context.compaction') {
      throw new Error('expected a compaction event');
    }
    expect(compactionEvent.outcome).toBe('skipped_invalid');
  });

  it('emits a skipped_blocked compaction event when the turn is cancelled before compaction can run, and does not overwrite context', async () => {
    const model = makeMockILLM();
    const capability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
    });
    const processor = capability.preLLMProcessors?.[0];
    if (processor === undefined) throw new Error('expected a preLLMProcessor');
    const controller = new AbortController();
    controller.abort(new Error('cancel before compaction'));
    const events = [];
    for await (const event of processor.processPreLLM({ ...makeExecution(), signal: controller.signal })) {
      events.push(event);
    }
    expect(events.find(event => event.type === 'agent.context.overwrite')).toBeUndefined();
    expect(model.createNonStream).not.toHaveBeenCalled();
    const compactionEvent = events.find(event => event.type === 'agent.context.compaction');
    if (compactionEvent === undefined || compactionEvent.type !== 'agent.context.compaction') {
      throw new Error('expected a compaction event');
    }
    expect(compactionEvent.outcome).toBe('skipped_blocked');
    expect(compactionEvent.tokens_before).toBe(compactionEvent.tokens_after);
  });

  it('emits a skipped_blocked compaction event when the turn is cancelled during the model request, and does not overwrite context', async () => {
    const controller = new AbortController();
    const model = makeMockILLM({
      createNonStream: jest.fn().mockImplementation(async () => {
        controller.abort(new Error('cancel during request'));
        return {
          output: { role: 'assistant', content: 'should not be used' },
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          finish_reason: 'stop',
        };
      }),
    });
    const capability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      boundRepository: STUB_BOUND_REPOSITORY,
    });
    const processor = capability.preLLMProcessors?.[0];
    if (processor === undefined) throw new Error('expected a preLLMProcessor');
    const events = [];
    let caughtError: Error | undefined;
    try {
      for await (const event of processor.processPreLLM({ ...makeExecution(), signal: controller.signal })) {
        events.push(event);
      }
    } catch (error) {
      caughtError = error instanceof Error ? error : undefined;
    }
    expect(events.find(event => event.type === 'agent.context.overwrite')).toBeUndefined();
    expect(caughtError).toBeDefined();
    const compactionEvent = events.find(event => event.type === 'agent.context.compaction');
    if (compactionEvent === undefined || compactionEvent.type !== 'agent.context.compaction') {
      throw new Error('expected a compaction event');
    }
    expect(compactionEvent.outcome).toBe('skipped_blocked');
    expect(compactionEvent.tokens_before).toBe(compactionEvent.tokens_after);
  });

  it('uses conversation mode for plain chats with no sandbox, bound repository, or checklist configured', async () => {
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('conv-state') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const capability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      // checklistState is intentionally left undefined to test that plain chats don't get
      // misclassified as coding just because checklistState exists
    });
    const events = await collectProcessPreLLM(capability);
    expect(model.createNonStream).toHaveBeenCalledTimes(1);
    const calls = jest.mocked(model.createNonStream).mock.calls;
    const messages = calls[0]?.[0].messages;
    expect(messages).toBeDefined();
    const messageContent = JSON.stringify(messages);
    // Conversation template includes these specific sections that coding template doesn't
    expect(messageContent).toContain('user_goal');
    expect(messageContent).toContain('facts_established');
    expect(messageContent).toContain('answers_given');
    expect(messageContent).toContain('open_questions');
    expect(messageContent).toContain('user_preferences_and_constraints');
    expect(messageContent).toContain('last_request');
    // Should not include coding-specific sections
    expect(messageContent).not.toContain('done_so_far');
    expect(messageContent).not.toContain('remaining_work');
    expect(messageContent).not.toContain('current_blocker');
    // Verify compaction actually ran and produced a compaction event with conversation mode
    const compactionEvent = events.find(e => e.type === 'agent.context.compaction');
    expect(compactionEvent).toBeDefined();
    if (compactionEvent !== undefined && compactionEvent.type === 'agent.context.compaction') {
      expect(compactionEvent.mode).toBe('conversation');
    }
  });

  it('compacts in conversation mode when a checklist is wired but holds no items, with no sandbox use or bound repository', async () => {
    const checklist: TaskChecklistAccess = {
      getTaskChecklist: jest.fn().mockResolvedValue({ revision: 1, items: [] }),
      replaceTaskChecklist: jest.fn(),
    };
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedConversationSummary('Planning a trip') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const capability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      checklist,
    });
    const events = await collectProcessPreLLM(capability);
    // Checklist is not fetched in conversation mode, so it should not be called.
    expect(checklist.getTaskChecklist).not.toHaveBeenCalled();
    const calls = jest.mocked(model.createNonStream).mock.calls;
    const messageContent = JSON.stringify(calls[0]?.[0].messages);
    expect(messageContent).toContain('last_request');
    expect(messageContent).not.toContain('remaining_work');
    const compactionEvent = events.find(e => e.type === 'agent.context.compaction');
    if (compactionEvent === undefined || compactionEvent.type !== 'agent.context.compaction') {
      throw new Error('expected a compaction event');
    }
    expect(compactionEvent.mode).toBe('conversation');
  });

  it('compacts in conversation mode when the checklist holds items, with no sandbox use or bound repository', async () => {
    const checklist: TaskChecklistAccess = {
      getTaskChecklist: jest
        .fn()
        .mockResolvedValue({ revision: 1, items: [{ id: 'task-1', text: 'Ship the fix', done: false }] }),
      replaceTaskChecklist: jest.fn(),
    };
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedConversationSummary('What is the weather like?') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const capability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      checklist,
    });
    const events = await collectProcessPreLLM(capability);
    // Checklist is not fetched in conversation mode, so it should not be called.
    expect(checklist.getTaskChecklist).not.toHaveBeenCalled();
    const calls = jest.mocked(model.createNonStream).mock.calls;
    const messageContent = JSON.stringify(calls[0]?.[0].messages);
    expect(messageContent).not.toContain('remaining_work');
    expect(messageContent).not.toContain('Ship the fix');
    const compactionEvent = events.find(e => e.type === 'agent.context.compaction');
    if (compactionEvent === undefined || compactionEvent.type !== 'agent.context.compaction') {
      throw new Error('expected a compaction event');
    }
    expect(compactionEvent.mode).toBe('conversation');
  });

  it('compacts in coding mode on a sandbox tool call in context, with no checklist or bound repository', async () => {
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('sandbox-state') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const capability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
    });
    const context: ContextMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: SANDBOX_EXEC_TOOL_NAME, arguments: '{}' },
            tool_info: {
              type: 'truefoundry-system',
              mcp_server_id: 'sandbox',
              mcp_server_name: 'Sandbox',
              original_tool_name: SANDBOX_EXEC_TOOL_NAME,
              is_approval_required: false,
            },
          },
        ],
      },
    ];
    const events = await collectProcessPreLLM(capability, context);
    const compactionEvent = events.find(e => e.type === 'agent.context.compaction');
    if (compactionEvent === undefined || compactionEvent.type !== 'agent.context.compaction') {
      throw new Error('expected a compaction event');
    }
    expect(compactionEvent.mode).toBe('coding');
  });

  it('compacts in coding mode when a repository is bound, with no checklist or sandbox use', async () => {
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('repo-state') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const capability = contextCompaction({
      logger: undefined,
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      boundRepository: STUB_BOUND_REPOSITORY,
    });
    const events = await collectProcessPreLLM(capability);
    const compactionEvent = events.find(e => e.type === 'agent.context.compaction');
    if (compactionEvent === undefined || compactionEvent.type !== 'agent.context.compaction') {
      throw new Error('expected a compaction event');
    }
    expect(compactionEvent.mode).toBe('coding');
  });

  it('calculates tokens_after from persisted context messages, not from the summarization request', async () => {
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('model-state') },
        // The summarization request had many tokens of input
        usage: { input_tokens: 5000, output_tokens: 100, total_tokens: 5100 },
        finish_reason: 'stop',
      }),
    });
    const events = await collectProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
        boundRepository: STUB_BOUND_REPOSITORY,
      }),
    );
    const compactionEvent = events.find(event => event.type === 'agent.context.compaction');
    if (compactionEvent === undefined || compactionEvent.type !== 'agent.context.compaction') {
      throw new Error('expected a compaction event');
    }
    expect(compactionEvent.outcome).toBe('applied');
    // tokens_after should be much smaller than the summarization request (5000 tokens)
    // because it's calculated from the two persisted messages (summary + continuation),
    // not from response.usage.input_tokens
    expect(compactionEvent.tokens_after).toBeLessThan(5000);
    expect(compactionEvent.tokens_after).toBeGreaterThan(0);

    // Also verify that the context overwrite event has the corrected token count
    const overwriteEvent = events.find(event => event.type === 'agent.context.overwrite');
    if (overwriteEvent === undefined || overwriteEvent.type !== 'agent.context.overwrite') {
      throw new Error('expected a context overwrite event');
    }
    expect(overwriteEvent.current_context_usage.prompt_tokens).toBeLessThan(5000);
    expect(overwriteEvent.current_context_usage.prompt_tokens).toBe(compactionEvent.tokens_after);
  });

  it('keeps the recent tail verbatim after compaction, with summary and continuation preceding it', async () => {
    const olderMessages: ContextMessage[] = [
      { role: 'user', content: 'help me with this' },
      { role: 'assistant', content: 'here is an approach' },
      { role: 'user', content: 'what should I do next' },
      { role: 'assistant', content: 'check the tests' },
    ];
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('unbound') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const events = await collectProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
        boundRepository: STUB_BOUND_REPOSITORY,
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
      olderMessages,
    );
    const overwrite = events.find(event => event.type === 'agent.context.overwrite');
    if (overwrite === undefined || overwrite.type !== 'agent.context.overwrite') {
      throw new Error('expected compaction overwrite');
    }
    expect(overwrite.context.length).toBeGreaterThanOrEqual(2);
    const summary = overwrite.context[0];
    const continuation = overwrite.context[1];
    const tail = overwrite.context.slice(2);
    if (summary) {
      const summaryContent = Reflect.get(summary, 'content');
      if (typeof summaryContent === 'string') {
        expect(summaryContent).toContain('host-written summary');
      }
    }
    if (continuation) {
      const continuationContent = Reflect.get(continuation, 'content');
      if (typeof continuationContent === 'string') {
        expect(continuationContent).toContain('Resume');
      }
    }
    if (tail.length > 0) {
      const lastInTail = tail[tail.length - 1];
      if (
        lastInTail &&
        isLLMContextMessage(lastInTail) &&
        lastInTail.role === 'assistant' &&
        typeof lastInTail.content === 'string'
      ) {
        expect(lastInTail.content).toBe('check the tests');
      }
    }
  });

  it('ensures the tail never starts with a tool message', async () => {
    const callId = 'tool-call-1';
    const toolInfo: InternalToolCallInfo = {
      type: 'truefoundry-system',
      mcp_server_id: 'sandbox',
      mcp_server_name: 'Sandbox',
      original_tool_name: 'exec',
      is_approval_required: false,
      effect: 'inspect',
    };
    const context: ContextMessage[] = [
      { role: 'user', content: 'do something' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: { name: 'sandbox__exec', arguments: 'echo hello' },
            tool_info: toolInfo,
          },
        ],
      },
      { role: 'tool', tool_call_id: callId, content: 'hello' },
      { role: 'assistant', content: 'tool executed' },
    ];
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('unbound') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const events = await collectProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
        boundRepository: STUB_BOUND_REPOSITORY,
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
      context,
    );
    const overwrite = events.find(event => event.type === 'agent.context.overwrite');
    if (overwrite === undefined || overwrite.type !== 'agent.context.overwrite') {
      throw new Error('expected compaction overwrite');
    }
    const tail = overwrite.context.slice(2);
    if (tail.length > 0) {
      const firstTail = tail[0];
      if (firstTail && isLLMContextMessage(firstTail)) {
        expect(firstTail.role).not.toBe('tool');
      }
    }
  });

  it('loops the tool-boundary guard when multiple tool results follow an assistant', async () => {
    const callIdA = 'tool-call-a';
    const callIdB = 'tool-call-b';
    const toolInfo: InternalToolCallInfo = {
      type: 'truefoundry-system',
      mcp_server_id: 'sandbox',
      mcp_server_name: 'Sandbox',
      original_tool_name: 'exec',
      is_approval_required: false,
      effect: 'inspect',
    };
    const context: ContextMessage[] = [
      { role: 'user', content: 'do something' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: callIdA,
            type: 'function',
            function: { name: 'sandbox__exec', arguments: 'cmd a' },
            tool_info: toolInfo,
          },
          {
            id: callIdB,
            type: 'function',
            function: { name: 'sandbox__exec', arguments: 'cmd b' },
            tool_info: toolInfo,
          },
        ],
      },
      { role: 'tool', tool_call_id: callIdA, content: 'result a' },
      { role: 'tool', tool_call_id: callIdB, content: 'result b' },
    ];
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('unbound') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    const events = await collectProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
        boundRepository: STUB_BOUND_REPOSITORY,
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
      context,
    );
    const overwrite = events.find(event => event.type === 'agent.context.overwrite');
    if (overwrite === undefined || overwrite.type !== 'agent.context.overwrite') {
      throw new Error('expected compaction overwrite');
    }
    const tail = overwrite.context.slice(2);
    expect(tail.length).toBeGreaterThan(0);
    const firstTail = tail[0];
    if (firstTail && isLLMContextMessage(firstTail)) {
      expect(firstTail.role).toBe('assistant');
    }
  });

  it('only sends the older part to the summarization model', async () => {
    const recentMessage: ContextMessage = { role: 'user', content: 'this should not reach the model' };
    const olderMessages: ContextMessage[] = [{ role: 'user', content: 'this should be summarized' }, recentMessage];
    const model = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: { role: 'assistant', content: completedSummary('unbound') },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
    });
    await collectProcessPreLLM(
      contextCompaction({
        logger: undefined,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
        boundRepository: STUB_BOUND_REPOSITORY,
        compactionThresholdTokens: ALWAYS_TRIGGERS_THRESHOLD,
      }),
      olderMessages,
    );
    const request = jest.mocked(model.createNonStream).mock.calls[0]?.[0];
    const messageIndex1 = request?.messages[1];
    let transcript = '';
    if (messageIndex1 && typeof messageIndex1.content === 'string') {
      transcript = messageIndex1.content;
    }
    expect(transcript).toContain('this should be summarized');
    expect(transcript).not.toContain('this should not reach the model');
  });

  it('rejects a coding summary missing the findings section', () => {
    const summaryWithoutFindings = completedSummary('unbound').replace(
      '## findings\n- src/ContextCompaction.ts: compaction logic implementation\n- tests/ContextCompaction.test.ts: unit tests for compaction\n',
      '',
    );
    const result = validateCompactionSummary(summaryWithoutFindings, REQUIRED_SUMMARY_SECTIONS, '');
    expect(result.reason).toBe('missing_section');
  });

  it('rejects a coding summary missing the user_request section', () => {
    const summaryWithoutUserRequest = completedSummary('unbound').replace(
      '## user_request\nContinue with the next step of the implementation.\n',
      '',
    );
    const result = validateCompactionSummary(summaryWithoutUserRequest, REQUIRED_SUMMARY_SECTIONS, '');
    expect(result.reason).toBe('missing_section');
  });

  it('rejects a coding summary missing the workspace section', () => {
    const summaryWithoutWorkspace = completedSummary('unbound').replace(
      '## workspace\n/repo cloned from git@github.com:example/project.git on branch main.\n',
      '',
    );
    const result = validateCompactionSummary(summaryWithoutWorkspace, REQUIRED_SUMMARY_SECTIONS, '');
    expect(result.reason).toBe('missing_section');
  });
});

describe('resolveCompactionThresholdTokens', () => {
  it('prefers an explicit input-token trigger', () => {
    expect(
      resolveCompactionThresholdTokens({
        configuredThresholdTokens: 80_000,
        modelContextLength: 200_000,
        modelParams: { max_tokens: 150_000 },
      }),
    ).toBe(80_000);
  });

  it('defaults to 80% of the model context length', () => {
    expect(
      resolveCompactionThresholdTokens({
        configuredThresholdTokens: undefined,
        modelContextLength: 128_001,
        modelParams: undefined,
      }),
    ).toBe(102_400);
  });

  it.each([
    { modelParams: { max_tokens: 32_768 }, name: 'max_tokens' },
    { modelParams: { max_completion_tokens: 32_768 }, name: 'max_completion_tokens' },
  ])('reserves the configured $name output budget', ({ modelParams }) => {
    expect(
      resolveCompactionThresholdTokens({
        configuredThresholdTokens: undefined,
        modelContextLength: 128_000,
        modelParams,
      }),
    ).toBe(95_232);
  });

  it('prefers max_completion_tokens over max_tokens', () => {
    expect(
      resolveCompactionThresholdTokens({
        configuredThresholdTokens: undefined,
        modelContextLength: 128_000,
        modelParams: { max_completion_tokens: 32_768, max_tokens: 64_000 },
      }),
    ).toBe(95_232);
  });

  it('keeps the 80% threshold when it already leaves enough output budget', () => {
    expect(
      resolveCompactionThresholdTokens({
        configuredThresholdTokens: undefined,
        modelContextLength: 128_000,
        modelParams: { max_tokens: 16_000 },
      }),
    ).toBe(102_400);
  });

  it.each([
    { modelParams: { max_tokens: 128_000 }, name: 'max_tokens equal to the context length' },
    { modelParams: { max_completion_tokens: 200_000 }, name: 'max_completion_tokens above the context length' },
    { modelParams: { max_tokens: 127_999.5 }, name: 'max_tokens leaving less than one whole input token' },
  ])('falls back to the 80% threshold when $name leaves no input budget', ({ modelParams }) => {
    expect(
      resolveCompactionThresholdTokens({
        configuredThresholdTokens: undefined,
        modelContextLength: 128_000,
        modelParams,
      }),
    ).toBe(102_400);
  });

  it('falls back to 50K when the model context length is unknown', () => {
    expect(
      resolveCompactionThresholdTokens({
        configuredThresholdTokens: undefined,
        modelContextLength: undefined,
        modelParams: { max_tokens: 32_768 },
      }),
    ).toBe(DEFAULT_CONTEXT_COMPACTION_THRESHOLD_TOKENS);
  });
});
