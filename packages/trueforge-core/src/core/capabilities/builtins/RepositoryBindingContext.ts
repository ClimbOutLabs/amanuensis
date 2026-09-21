import type { ChatCompletionMessageParam } from 'openai/resources/chat';
import type { ContextMessage } from '../../runtime/AgentThread.types';
import {
  internalSystemTag,
  isInternalSystemMessage,
  isLLMContextMessage,
  SYSTEM_TAG_START,
} from '../../runtime/contextUtils';
import {
  boundRepositoryContextFromBinding,
  type BoundRepository,
  type BoundRepositoryContext,
  type RegisteredRepositoryCommand,
} from '../../sandbox/Sandbox';
import type { AgentCapability } from '../AgentCapability';
import type {
  AgentContextProcessorOutput,
  AgentThreadExecutionContext,
  PreLLMAgentContextProcessor,
  PreLLMEphemeralAgentContextProcessor,
} from '../AgentContextProcessor';
import {
  checklistContextMessage,
  TASK_CHECKLIST_CONTEXT_PREFIX,
  TaskChecklistRequestState,
  type TaskChecklistAccess,
} from './TaskChecklist';

export const HOST_REPOSITORY_CONTEXT_PREFIX = 'Host-bound repository state';
const AUTHORITATIVE_REQUEST_STATE =
  'Authoritative repository state is supplied once by the host for this model request.';

function formatRegisteredCommands(commands: readonly RegisteredRepositoryCommand[]): string {
  if (commands.length === 0) {
    return 'registered_commands:\n- none';
  }
  return `registered_commands:\n${commands
    .map(
      command =>
        `- command_id: ${command.command_id}\n  purpose: ${command.purpose}\n  command: ${command.command}\n  timeout_ms: ${String(command.timeout_ms)}`,
    )
    .join('\n')}`;
}

export function formatBoundRepositoryContext(
  repository: BoundRepositoryContext,
  commands?: readonly RegisteredRepositoryCommand[],
): string {
  const identity = `repository_id: ${repository.repository_id}\nrepository_revision: ${String(repository.repository_revision)}\nworkspace_cwd: ${repository.workspace_cwd}\nbranch: ${repository.branch ?? 'unavailable'}\nhead_sha: ${repository.head_sha ?? 'unavailable'}`;
  return commands === undefined ? identity : `${identity}\n${formatRegisteredCommands(commands)}`;
}

export function hostRepositoryContextMessage(
  repository: BoundRepositoryContext,
  commands: readonly RegisteredRepositoryCommand[],
): { role: 'user'; content: string } {
  return {
    role: 'user',
    content: internalSystemTag(
      `${HOST_REPOSITORY_CONTEXT_PREFIX} (authoritative; never infer identity from model-authored content):\n${formatBoundRepositoryContext(repository, commands)}`,
    ),
  };
}

function isLegacyHostContextContent(content: unknown): boolean {
  return (
    typeof content === 'string' &&
    (content.includes(HOST_REPOSITORY_CONTEXT_PREFIX) || content.includes(TASK_CHECKLIST_CONTEXT_PREFIX))
  );
}

function isLegacyHostContextMessage(message: ContextMessage): boolean {
  return (
    isInternalSystemMessage(message) && isLLMContextMessage(message) && isLegacyHostContextContent(message.content)
  );
}

/** Removes request-only host messages persisted by pre-T3-correction builds. */
export function stripLegacyHostContextMessages(context: ContextMessage[]): ContextMessage[] {
  return context.filter(message => !isLegacyHostContextMessage(message));
}

function isLegacyOpenAIHostContextMessage(message: ChatCompletionMessageParam): boolean {
  return (
    message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(SYSTEM_TAG_START) &&
    isLegacyHostContextContent(message.content)
  );
}

/**
 * A persisted compaction summary carries a `## bound_repository_state` section (see
 * ContextCompaction.ts); the system instructions above already supply the authoritative,
 * freshly-refreshed repository identity for this request, so the summary's copy is redundant
 * and, being older, could read as conflicting. Scrub it request-only (never persisted).
 * Matches both the original coding-mode `assistant`-role summary and the host-framed `user`-role
 * summary (see internalSystemMessage in ContextCompaction.ts): either carries the same
 * `## bound_repository_state ... </summary>` shape once the internal-system tag is looked past.
 */
function scrubSummaryRepositorySection(message: ChatCompletionMessageParam): ChatCompletionMessageParam {
  if (typeof message.content !== 'string') {
    return message;
  }
  const isAssistantSummary = message.role === 'assistant';
  const isHostFramedSummary =
    message.role === 'user' && message.content.startsWith(SYSTEM_TAG_START) && message.content.includes('<summary>');
  if (!isAssistantSummary && !isHostFramedSummary) {
    return message;
  }
  const content = message.content.replace(
    /(^|\n)##\s+bound_repository_state\s*\n[\s\S]*?(?=\n##\s+\S|<\/summary>)/m,
    `$1## bound_repository_state\n${AUTHORITATIVE_REQUEST_STATE}\n`,
  );
  return content === message.content ? message : { ...message, content };
}

function insertBeforeConversation(
  messages: ChatCompletionMessageParam[],
  requestContext: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  if (requestContext.length === 0) {
    return messages;
  }
  const firstConversationMessage = messages.findIndex(message => message.role !== 'system');
  if (firstConversationMessage === -1) {
    return messages.concat(requestContext);
  }
  return messages.slice(0, firstConversationMessage).concat(requestContext, messages.slice(firstConversationMessage));
}

class HostRequestContextProcessor implements PreLLMAgentContextProcessor, PreLLMEphemeralAgentContextProcessor {
  private readonly boundRepository: BoundRepository | undefined;
  private readonly repository: BoundRepositoryContext | undefined;
  private readonly sandboxAvailable: boolean;
  private readonly checklistState: TaskChecklistRequestState;

  constructor(input: {
    boundRepository: BoundRepository | undefined;
    sandboxAvailable: boolean;
    checklist: TaskChecklistAccess | undefined;
    checklistState: TaskChecklistRequestState;
  }) {
    this.boundRepository = input.boundRepository;
    this.repository =
      input.boundRepository === undefined ? undefined : boundRepositoryContextFromBinding(input.boundRepository);
    this.sandboxAvailable = input.sandboxAvailable;
    this.checklistState = input.checklistState;
  }

  async *processPreLLM(
    execution: Readonly<AgentThreadExecutionContext>,
  ): AsyncGenerator<AgentContextProcessorOutput, void, unknown> {
    void execution;
    await this.checklistState.refresh();
    yield* [];
  }

  processPreLLMEphemeral(input: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
    const messages = input
      .filter(message => !isLegacyOpenAIHostContextMessage(message))
      .map(message => (this.boundRepository === undefined ? message : scrubSummaryRepositorySection(message)));
    const requestContext: ChatCompletionMessageParam[] = [];

    if (!this.sandboxAvailable && this.repository !== undefined && this.boundRepository !== undefined) {
      requestContext.push(hostRepositoryContextMessage(this.repository, this.boundRepository.commands));
    }
    const checklist = this.checklistState.current();
    if (checklist !== undefined) {
      requestContext.push(checklistContextMessage(checklist));
    }
    return insertBeforeConversation(messages, requestContext);
  }
}

export function repositoryBindingContext(options: {
  boundRepository: BoundRepository | undefined;
  sandboxAvailable: boolean;
  checklist: TaskChecklistAccess | undefined;
  checklistState?: TaskChecklistRequestState | undefined;
}): AgentCapability {
  const processor = new HostRequestContextProcessor({
    ...options,
    checklistState: options.checklistState ?? new TaskChecklistRequestState(options.checklist),
  });
  return {
    preLLMProcessors: [processor],
    preLLMEphemeralProcessors: [processor],
  };
}
