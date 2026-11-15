/**
 * The longest any memory deadline may be. The browser keeps a memory write request alive for
 * slightly longer than this, so both limits are derived from the one number.
 */
export const MEMORY_MAX_TIMEOUT_MS = 120_000;
