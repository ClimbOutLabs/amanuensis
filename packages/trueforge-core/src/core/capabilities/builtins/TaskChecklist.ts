import { z } from 'zod';
import type { TaskChecklist, TaskChecklistItem } from '../../../agent-session/schemas/taskChecklist';
import { ReplaceTaskChecklistRequestSchema } from '../../../agent-session/schemas/taskChecklist';
import { StaleTaskChecklistError } from '../../../agent-session/store/SessionStoreErrors';
import { type CallToolResponse, toolResultResponse } from '../../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../mcp/LocalToolMCP';
import { internalSystemTag } from '../../runtime/contextUtils';
import type { AgentTracing } from '../../tracing/AgentTracing';
import type { AgentCapability } from '../AgentCapability';

export const TASK_CHECKLIST_SERVER_ID = 'task-checklist';
export const REPLACE_TASK_CHECKLIST_TOOL_NAME = 'replace_task_checklist';
export const TASK_CHECKLIST_CONTEXT_PREFIX = 'Durable task checklist (host-owned; ordered items only):';

export interface TaskChecklistAccess {
  getTaskChecklist(): Promise<TaskChecklist>;
  replaceTaskChecklist(input: { expected_revision: number; items: TaskChecklistItem[] }): Promise<TaskChecklist>;
}

/** One bounded, host-owned checklist snapshot shared by request-context processors. */
export class TaskChecklistRequestState {
  private checklist: TaskChecklist | undefined;

  constructor(private readonly access: TaskChecklistAccess | undefined) {}

  async refresh(): Promise<TaskChecklist | undefined> {
    this.checklist = this.access === undefined ? undefined : await this.access.getTaskChecklist();
    return this.checklist;
  }

  current(): TaskChecklist | undefined {
    return this.checklist;
  }
}

export function checklistContextMessage(checklist: TaskChecklist): { role: 'user'; content: string } {
  const items =
    checklist.items.length === 0
      ? '- none'
      : checklist.items.map(item => `- [${item.done ? 'x' : ' '}] ${item.id}: ${item.text}`).join('\n');
  return {
    role: 'user',
    content: internalSystemTag(`${TASK_CHECKLIST_CONTEXT_PREFIX}\nrevision: ${String(checklist.revision)}\n${items}`),
  };
}

interface StaleReplacementSequence {
  initial_attempt_key: string;
  retry_attempt_key: string | undefined;
  current: TaskChecklist;
}

function replacementAttemptKey(input: z.infer<typeof ReplaceTaskChecklistRequestSchema>): string {
  return JSON.stringify({ expected_revision: input.expected_revision, items: input.items });
}

class TaskChecklistTool extends LocalToolMCP {
  readonly name = TASK_CHECKLIST_SERVER_ID;
  readonly displayName = 'TaskChecklist';
  private staleSequence: StaleReplacementSequence | undefined;

  constructor(
    private readonly access: TaskChecklistAccess,
    tracing: AgentTracing,
  ) {
    super({ tracing });
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: REPLACE_TASK_CHECKLIST_TOOL_NAME,
      description:
        'Replace the durable task checklist with up to 50 ordered items. Each item has only an id, text, and done flag. Read the current revision from the injected checklist and retry a stale write at most once.',
      schema: ReplaceTaskChecklistRequestSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: input => this.replace(input),
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }

  private async replace(input: z.infer<typeof ReplaceTaskChecklistRequestSchema>): Promise<CallToolResponse> {
    const attemptKey = replacementAttemptKey(input);
    const activeSequence = this.staleSequence;
    if (activeSequence !== undefined) {
      if (activeSequence.retry_attempt_key !== undefined) {
        return this.staleResponse({
          message: 'Task checklist stale retry already used; wait for a new host sequence before replacing again.',
          current: activeSequence.current,
          retryAllowed: false,
        });
      }
      activeSequence.retry_attempt_key = attemptKey;
      if (attemptKey === activeSequence.initial_attempt_key) {
        return this.staleResponse({
          message: 'Task checklist retry repeated the identical stale revision and content.',
          current: activeSequence.current,
          retryAllowed: false,
        });
      }
    }
    try {
      const checklist = await this.access.replaceTaskChecklist(input);
      this.staleSequence = undefined;
      return toolResultResponse({
        text: JSON.stringify({ status: 'saved', task_checklist: checklist }),
      });
    } catch (error) {
      if (!(error instanceof StaleTaskChecklistError)) {
        throw error;
      }
      const retryAllowed = activeSequence === undefined;
      if (activeSequence === undefined) {
        this.staleSequence = {
          initial_attempt_key: attemptKey,
          retry_attempt_key: undefined,
          current: error.current,
        };
      } else {
        activeSequence.current = error.current;
      }
      return this.staleResponse({
        message: error.message,
        current: error.current,
        retryAllowed,
      });
    }
  }

  private staleResponse(input: { message: string; current: TaskChecklist; retryAllowed: boolean }): CallToolResponse {
    return toolResultResponse({
      text: JSON.stringify({
        error: 'stale_task_checklist',
        message: input.message,
        current_task_checklist: input.current,
        retry_allowed: input.retryAllowed,
      }),
      isError: true,
    });
  }
}

export function taskChecklist(options: { access: TaskChecklistAccess; tracing: AgentTracing }): AgentCapability {
  return {
    systemToolSets: [new TaskChecklistTool(options.access, options.tracing)],
  };
}
