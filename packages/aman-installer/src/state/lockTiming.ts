// The state lock's clock, as installer/STATE.md ("The lock") writes it down.
// Every holder refreshes the lock each beat, so a live run, however long it
// takes, never looks stopped; a lock is dead only when its beats stopped.
export interface LockTiming {
  beatSeconds: number;
  deadSeconds: number;
}

export const LOCK_TIMING: LockTiming = { beatSeconds: 15, deadSeconds: 120 };
