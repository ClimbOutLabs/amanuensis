import {
  recoverAbandonedCommandExecutions,
  type CommandExecutionRecoveryStore,
} from '../../../src/runtime/commandExecutionRecovery';

describe('registered command execution recovery', () => {
  it('recovers only turns owned by executors whose heartbeat is absent', async () => {
    const recoverRunningCommandExecutions = jest.fn<
      ReturnType<CommandExecutionRecoveryStore['recoverRunningCommandExecutions']>,
      Parameters<CommandExecutionRecoveryStore['recoverRunningCommandExecutions']>
    >(async () => 2);
    const store: CommandExecutionRecoveryStore = {
      listRunningCommandExecutionOwnerIds: async () => ['live', 'dead'],
      recoverRunningCommandExecutions,
    };
    const isExecutorAlive = jest.fn(async (executorId: string) => executorId === 'live');

    const result = await recoverAbandonedCommandExecutions({
      store,
      isExecutorAlive,
      completedAt: new Date('2026-08-31T15:00:00.000Z'),
    });

    expect(isExecutorAlive).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ recovered: 2, staleOwnerIds: ['dead'] });
    expect(recoverRunningCommandExecutions).toHaveBeenCalledWith({
      completed_at: new Date('2026-08-31T15:00:00.000Z'),
      owner_ids: ['dead'],
      require_expired_lease: true,
    });
  });

  it('does not recover anything when all owners are alive', async () => {
    const recoverRunningCommandExecutions = jest.fn<
      ReturnType<CommandExecutionRecoveryStore['recoverRunningCommandExecutions']>,
      Parameters<CommandExecutionRecoveryStore['recoverRunningCommandExecutions']>
    >(async () => 0);
    const store: CommandExecutionRecoveryStore = {
      listRunningCommandExecutionOwnerIds: async () => ['live'],
      recoverRunningCommandExecutions,
    };

    await expect(
      recoverAbandonedCommandExecutions({
        store,
        isExecutorAlive: async () => true,
        completedAt: new Date('2026-08-31T15:00:00.000Z'),
      }),
    ).resolves.toEqual({ recovered: 0, staleOwnerIds: [] });
    expect(recoverRunningCommandExecutions).not.toHaveBeenCalled();
  });

  it('fails closed without changing records when liveness cannot be established', async () => {
    const recoverRunningCommandExecutions = jest.fn<
      ReturnType<CommandExecutionRecoveryStore['recoverRunningCommandExecutions']>,
      Parameters<CommandExecutionRecoveryStore['recoverRunningCommandExecutions']>
    >(async () => 0);
    const store: CommandExecutionRecoveryStore = {
      listRunningCommandExecutionOwnerIds: async () => ['replica-a', 'replica-b'],
      recoverRunningCommandExecutions,
    };

    await expect(
      recoverAbandonedCommandExecutions({
        store,
        isExecutorAlive: async executorId => {
          if (executorId === 'replica-b') {
            throw new Error('Redis unavailable');
          }
          return false;
        },
        completedAt: new Date('2026-08-31T15:00:00.000Z'),
      }),
    ).rejects.toThrow('Redis unavailable');
    expect(recoverRunningCommandExecutions).not.toHaveBeenCalled();
  });
});
