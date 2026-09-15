import { EventType, ToolExecutionStartedEventSchema } from '../../../src/core/events/schema';

describe('ToolExecutionStartedEventSchema', () => {
  it('carries host-resolved registered-command execution metadata', () => {
    const event = ToolExecutionStartedEventSchema.parse({
      type: EventType.TOOL_EXECUTION_STARTED,
      id: 'event-1',
      thread_id: 'main',
      tool_call_id: 'call-1',
      tool_name: 'sandbox__run_registered_command',
      created_at: '2026-08-31T12:00:00.000Z',
      command_execution: {
        repository_id: 'repo-1',
        repository_revision: 7,
        command_id: 'verify',
        command: 'pnpm verify',
        cwd: '/workspace/repo',
        timeout_ms: 900_000,
      },
    });

    expect(event.command_execution).toEqual({
      repository_id: 'repo-1',
      repository_revision: 7,
      command_id: 'verify',
      command: 'pnpm verify',
      cwd: '/workspace/repo',
      timeout_ms: 900_000,
    });
  });

  it('rejects an invalid registered-command timeout', () => {
    expect(() =>
      ToolExecutionStartedEventSchema.parse({
        type: EventType.TOOL_EXECUTION_STARTED,
        id: 'event-1',
        thread_id: 'main',
        tool_call_id: 'call-1',
        tool_name: 'sandbox__run_registered_command',
        created_at: '2026-08-31T12:00:00.000Z',
        command_execution: {
          repository_id: 'repo-1',
          repository_revision: 7,
          command_id: 'verify',
          command: 'pnpm verify',
          cwd: '/workspace/repo',
          timeout_ms: 0,
        },
      }),
    ).toThrow();
  });
});
