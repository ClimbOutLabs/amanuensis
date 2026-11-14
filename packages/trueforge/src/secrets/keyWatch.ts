import type { SecretVault, SecretVaultState } from './secretVault';

/**
 * Keeps checking for the key while secrets are locked, so Aman unlocks by itself when the host
 * delivers the key after the containers started. Checks often for the first ten minutes after
 * start, then every 30 seconds. Returns a function that stops checking.
 */
export function watchForKey({
  vault,
  onChange,
  fastMs = 2_000,
  fastForMs = 10 * 60_000,
  slowMs = 30_000,
  now = Date.now,
}: {
  vault: SecretVault;
  onChange: (state: SecretVaultState) => void;
  fastMs?: number;
  fastForMs?: number;
  slowMs?: number;
  now?: () => number;
}): () => void {
  const startedAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let last = '';

  const report = (state: SecretVaultState): void => {
    const key = state.status === 'unlocked' ? 'unlocked' : `${state.reason}:${state.detail}`;
    if (key !== last) {
      last = key;
      onChange(state);
    }
  };

  const tick = async (): Promise<void> => {
    let state: SecretVaultState;
    try {
      state = await vault.refresh();
    } catch (caught) {
      state = {
        status: 'locked',
        reason: 'no_key',
        detail: caught instanceof Error ? caught.message : 'Could not check the key',
      };
    }
    report(state);
    if (stopped || state.status === 'unlocked') {
      return;
    }
    timer = setTimeout(() => void tick(), now() - startedAt < fastForMs ? fastMs : slowMs);
    timer.unref();
  };

  void tick();
  return () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
}
