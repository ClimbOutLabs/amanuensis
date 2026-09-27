/**
 * Default single-tenant id. Lives here — not in an API module — so boot code
 * (and anything else outside the API layer) can reference it without pulling
 * the API dependency graph into the startup path.
 *
 * Kept for the API modules that have not yet moved to `resolveRequestContext`'s
 * per-request tenant (bugReport, capabilities, mcpServers, personalization,
 * personas, repositories, sessionFolders, turns).
 */
export const TENANT_ID = 'default';
