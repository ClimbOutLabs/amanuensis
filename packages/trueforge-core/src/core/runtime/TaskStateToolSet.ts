import { toolResultResponse } from '../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../mcp/LocalToolMCP';
import type { AgentTracing } from '../tracing/AgentTracing';
import { MAX_TASK_FINDINGS, TASK_STATE_TOOL_NAME, TaskFindingSchema, type TaskFinding } from './taskState';

/**
 * Host-owned in-process tool set exposing `record_finding`.
 *
 * The tool is the model's structured write path into task state (the
 * ADK-`output_key` analogue): instead of leaving findings as transcript
 * messages that context compaction may later discard, the model banks each
 * useful result here and the host re-injects the full scratchpad before every
 * model call. It is only registered for agents that opt into a tool-call
 * budget (`AgentDefinition.toolCallBudget`), and its own invocations are
 * exempt from that budget.
 *
 * Durable-state ordering: the handler STAGES findings instead of mutating
 * the live task state. AgentThread folds staged findings into a cloned next
 * state, persists that state via the tool-results context append, and only
 * then advances its live state — `yield event; mutateMemory()`. A crash
 * between the tool response and the append therefore never leaves the store
 * behind the "recorded: true" the model already saw.
 */
export class TaskStateToolSet extends LocalToolMCP {
  readonly name = 'task-state';
  readonly displayName = 'Task State';

  private readonly pendingFindings: TaskFinding[] = [];
  private readonly bankedCount: () => number;

  constructor(options: { tracing: AgentTracing; bankedCount: () => number }) {
    super({ tracing: options.tracing });
    this.bankedCount = options.bankedCount;
  }

  protected getTools(): ToolDefinition[] {
    return [
      defineTool({
        name: TASK_STATE_TOOL_NAME,
        description: [
          'Bank one finding in your durable task scratchpad.',
          'Use this for every useful result you gather: the scratchpad is re-injected fresh before each of your steps and survives context compaction, unlike conversation messages. Compose your final answer from the banked findings.',
          `At most ${String(MAX_TASK_FINDINGS)} findings per request.`,
        ].join(' '),
        schema: TaskFindingSchema,
        // eslint-disable-next-line @typescript-eslint/require-await -- defineTool requires an async handler
        handler: async input => {
          if (this.bankedCount() + this.pendingFindings.length >= MAX_TASK_FINDINGS) {
            return toolResultResponse({
              text: JSON.stringify({
                recorded: false,
                error: `Finding limit reached (${String(MAX_TASK_FINDINGS)}). Compose your final answer from the recorded findings.`,
              }),
              isError: true,
            });
          }
          this.pendingFindings.push({ ...input });
          return toolResultResponse({ text: JSON.stringify({ recorded: true }) });
        },
      }),
    ];
  }

  /**
   * Findings staged by `record_finding` calls since the last drain, in call
   * order. AgentThread drains these after the tool-results append is yielded
   * and folds them into the now-durable next task state.
   */
  public drainPendingFindings(): TaskFinding[] {
    const findings = [...this.pendingFindings];
    this.pendingFindings.length = 0;
    return findings;
  }
}
