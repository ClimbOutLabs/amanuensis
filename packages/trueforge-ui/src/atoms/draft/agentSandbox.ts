import type { AgentRuntimeConfig } from '../../server/types.js';

/** Absent config defaults to off, matching `SandboxConfigSchema`'s server-side default. */
export function readSandboxEnabled(config: AgentRuntimeConfig | undefined): boolean {
  return config?.sandbox?.enabled === true;
}

/** Toggles `config.sandbox.enabled`, preserving `fileDownloads` and every other config field. */
export function withSandboxEnabled(config: AgentRuntimeConfig | undefined, enabled: boolean): AgentRuntimeConfig {
  return {
    ...config,
    sandbox: {
      ...config?.sandbox,
      enabled,
    },
  };
}
