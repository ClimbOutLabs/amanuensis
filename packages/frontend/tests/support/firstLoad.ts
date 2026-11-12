/**
 * How long a test waits for the first page from a fresh Vite server. That load waits for the
 * dependency pre-bundle and cold compile, which is slow while the other browser suites run.
 */
export const FIRST_LOAD_TIMEOUT_MS = 120_000;
