import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { AgentSpec, TrueForgeAgentRuntimeConfig } from '../../server/types.js';

/** Catalog attach key may sit on `id`; wire Skill is name-only. See builder getSkills. */
export type HarnessSkillMount = TrueForgeApi.Skill & { id?: string };
export type HarnessMcpServerMount = TrueForgeApi.McpServer;

/**
 * Per-role model overrides for the host's own bounded operations. A role
 * exists only where a distinct model call does (compaction, delegation,
 * summarization);
 * absence means inherit `model`, resolved server-side at use rather than
 * copied at save time.
 */
export interface HarnessAuxiliaryModels {
  compaction?: TrueForgeApi.Model;
  delegation?: TrueForgeApi.Model;
  summarization?: TrueForgeApi.Model;
}

export interface HarnessAgentSpec
  extends
    AgentSpec<TrueForgeApi.Model, HarnessSkillMount, HarnessMcpServerMount, TrueForgeAgentRuntimeConfig>,
    Omit<TrueForgeApi.AgentSpec, 'skills' | 'config'> {
  config?: TrueForgeAgentRuntimeConfig;
}
