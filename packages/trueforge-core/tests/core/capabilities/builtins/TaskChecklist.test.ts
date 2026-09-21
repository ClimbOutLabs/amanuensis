import { z } from 'zod';
import {
  MAX_TASK_CHECKLIST_ITEMS,
  ReplaceTaskChecklistRequestSchema,
  TaskChecklistSchema,
} from '../../../../src/agent-session/schemas/taskChecklist';
import { StaleTaskChecklistError } from '../../../../src/agent-session/store/SessionStoreErrors';
import { taskChecklist } from '../../../../src/core/capabilities/builtins/TaskChecklist';
import type { CallToolResponse } from '../../../../src/core/mcp/IMCPServer';
import { isCallToolResponseResult } from '../../../../src/core/mcp/IMCPServer';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';

function stale(revision: number): StaleTaskChecklistError {
  return new StaleTaskChecklistError(0, { revision, items: [] });
}

function resultText(response: CallToolResponse): string {
  if (!isCallToolResponseResult(response)) {
    throw new Error('expected task checklist tool result');
  }
  const content = response.result.content[0];
  return content?.type === 'text' ? content.text : '';
}

describe('task checklist', () => {
  it('rejects duplicate ids and more than 50 items', () => {
    expect(() =>
      ReplaceTaskChecklistRequestSchema.parse({
        expected_revision: 0,
        items: [
          { id: 'same', text: 'one', done: false },
          { id: 'same', text: 'two', done: true },
        ],
      }),
    ).toThrow();
    expect(() =>
      TaskChecklistSchema.parse({
        revision: 0,
        items: Array.from({ length: MAX_TASK_CHECKLIST_ITEMS + 1 }, (_, index) => ({
          id: `item-${String(index)}`,
          text: 'bounded item',
          done: false,
        })),
      }),
    ).toThrow();
  });

  it('blocks an identical stale retry before calling the store', async () => {
    const replaceTaskChecklist = jest.fn().mockRejectedValue(stale(1));
    const capability = taskChecklist({
      access: {
        getTaskChecklist: jest.fn().mockResolvedValue({ revision: 0, items: [] }),
        replaceTaskChecklist,
      },
      tracing: NOOP_AGENT_TRACING,
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected task checklist tool set');
    }
    const input = {
      name: 'replace_task_checklist',
      arguments: { expected_revision: 0, items: [{ id: 'next', text: 'Continue', done: false }] },
    };

    const responseSchema = z.object({ retry_allowed: z.boolean() });
    const first = responseSchema.parse(JSON.parse(resultText(await toolSet.callTool(input))));
    const duplicate = responseSchema.parse(JSON.parse(resultText(await toolSet.callTool(input))));

    expect(first.retry_allowed).toBe(true);
    expect(duplicate.retry_allowed).toBe(false);
    expect(replaceTaskChecklist).toHaveBeenCalledTimes(1);
  });

  it('allows one changed retry, denies another stale attempt, and resets the sequence after success', async () => {
    const replaceTaskChecklist = jest
      .fn()
      .mockRejectedValueOnce(stale(1))
      .mockResolvedValueOnce({ revision: 2, items: [] })
      .mockRejectedValueOnce(stale(3))
      .mockRejectedValueOnce(stale(4))
      .mockRejectedValueOnce(stale(5));
    const capability = taskChecklist({
      access: {
        getTaskChecklist: jest.fn().mockResolvedValue({ revision: 0, items: [] }),
        replaceTaskChecklist,
      },
      tracing: NOOP_AGENT_TRACING,
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected task checklist tool set');
    }
    const initial = { name: 'replace_task_checklist', arguments: { expected_revision: 0, items: [] } };
    const retry = { name: 'replace_task_checklist', arguments: { expected_revision: 1, items: [] } };
    const later = { name: 'replace_task_checklist', arguments: { expected_revision: 2, items: [] } };
    const laterRetry = { name: 'replace_task_checklist', arguments: { expected_revision: 3, items: [] } };
    const deniedThird = { name: 'replace_task_checklist', arguments: { expected_revision: 4, items: [] } };

    const responseSchema = z.object({ retry_allowed: z.boolean().optional(), status: z.string().optional() });
    const first = responseSchema.parse(JSON.parse(resultText(await toolSet.callTool(initial))));
    const success = responseSchema.parse(JSON.parse(resultText(await toolSet.callTool(retry))));
    const afterSuccess = responseSchema.parse(JSON.parse(resultText(await toolSet.callTool(later))));
    const staleRetry = responseSchema.parse(JSON.parse(resultText(await toolSet.callTool(laterRetry))));
    const blocked = responseSchema.parse(JSON.parse(resultText(await toolSet.callTool(deniedThird))));

    expect(first.retry_allowed).toBe(true);
    expect(success.status).toBe('saved');
    expect(afterSuccess.retry_allowed).toBe(true);
    expect(staleRetry.retry_allowed).toBe(false);
    expect(blocked.retry_allowed).toBe(false);
    expect(replaceTaskChecklist).toHaveBeenCalledTimes(4);
  });

  it('keeps request-context injection out of the durable checklist tool capability', () => {
    const capability = taskChecklist({
      access: {
        getTaskChecklist: jest.fn().mockResolvedValue({ revision: 0, items: [] }),
        replaceTaskChecklist: jest.fn(),
      },
      tracing: NOOP_AGENT_TRACING,
    });

    expect(capability.preLLMProcessors).toBeUndefined();
    expect(capability.preLLMEphemeralProcessors).toBeUndefined();
  });
});
