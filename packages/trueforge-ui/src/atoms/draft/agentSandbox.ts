import type { AgentRuntimeConfig, AgentSpec } from '../../server/types.js';

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

/**
 * Whether the chat's turns are known to run without the sandbox. Only a loaded chat spec that names the
 * setting says so. A saved agent's chat, a spec still loading or failed to load, or one that never
 * stored the setting is not known, so nothing may tell the person to turn the sandbox on.
 */
export function chatSandboxKnownOff(draft: {
  agentSpec: AgentSpec | null;
  isSpecLoading: boolean;
  specError: unknown;
}): boolean {
  if (draft.agentSpec == null || draft.isSpecLoading || draft.specError != null) return false;
  return draft.agentSpec.config?.sandbox?.enabled === false;
}
