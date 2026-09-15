import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';

export type CommandExecutionRecoveryStore = Pick<
  ISessionStore,
  'listRunningCommandExecutionOwnerIds' | 'recoverRunningCommandExecutions'
>;

export interface CommandExecutionRecoveryResult {
  recovered: number;
  staleOwnerIds: string[];
}

/**
 * Recovers only executions whose owning replica is no longer live. Liveness is
 * resolved for every owner before any row changes, so an unavailable liveness
 * service cannot partially recover another replica's commands.
 */
export async function recoverAbandonedCommandExecutions({
  store,
  isExecutorAlive,
  completedAt,
}: {
  store: CommandExecutionRecoveryStore;
  isExecutorAlive: (executorId: string) => Promise<boolean>;
  completedAt: Date;
}): Promise<CommandExecutionRecoveryResult> {
  const runningOwnerIds = await store.listRunningCommandExecutionOwnerIds();
  // Resolve every liveness signal before asking the store to mutate. A failed
  // Redis read therefore cannot produce a partial recovery set.
  const ownerLiveness = await Promise.all(
    runningOwnerIds.map(async ownerId => ({ ownerId, alive: await isExecutorAlive(ownerId) })),
  );
  const staleOwnerIds = ownerLiveness
    .filter(owner => !owner.alive)
    .map(owner => owner.ownerId)
    .sort();

  if (staleOwnerIds.length === 0) {
    return { recovered: 0, staleOwnerIds };
  }
  const recovered = await store.recoverRunningCommandExecutions({
    completed_at: completedAt,
    owner_ids: staleOwnerIds,
    require_expired_lease: true,
  });
  return { recovered, staleOwnerIds };
}
