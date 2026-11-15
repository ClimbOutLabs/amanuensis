'use client';

import {
  useTrueFoundryAgentSpec,
  useTrueFoundryUpdateAgentSpec,
  type AgentSpecUpdate,
} from '@truefoundry/assistant-ui-runtime';

import type { Model } from '../../server/types.js';
import { RoleModelPicker } from './RoleModelPicker.js';

/**
 * Model roles for the host's own bounded operations. A role exists only where
 * a distinct model call does; see `auxiliary_models` on the agent spec.
 */
export type AuxiliaryModelRole = 'compaction' | 'delegation';

export type AuxiliaryModels = {
  compaction?: Model;
  delegation?: Model;
  summarization?: Model;
};

export type DraftAuxiliaryModelSelectorProps = {
  role: AuxiliaryModelRole;
  /** Human label used in titles and the "Select … model" affordance, e.g. "Compaction". */
  roleLabel: string;
  disabled?: boolean;
};

/**
 * Reads a role's model from the spec. The spec type comes from the external runtime package
 * and may lag behind newly added roles; treating it as the UI's AuxiliaryModels (a supertype
 * with the new role as optional) is safe for reads — an unset role simply yields undefined.
 */
function getRoleModel(auxiliaryModels: AuxiliaryModels | undefined, role: AuxiliaryModelRole): Model | undefined {
  return auxiliaryModels?.[role];
}

export function DraftAuxiliaryModelSelector({ role, roleLabel, disabled }: DraftAuxiliaryModelSelectorProps) {
  const { agentSpec } = useTrueFoundryAgentSpec();
  const updateAgentSpec = useTrueFoundryUpdateAgentSpec();
  const current: AuxiliaryModels | undefined = agentSpec?.auxiliaryModels;

  const choose = (modelName: string | undefined) => {
    const next: AuxiliaryModels = { ...current };
    if (modelName === undefined) {
      delete next[role];
    } else {
      next[role] = { name: modelName };
    }
    const patch: AgentSpecUpdate = { auxiliaryModels: Object.keys(next).length > 0 ? next : undefined };
    updateAgentSpec?.(patch);
  };

  return (
    <RoleModelPicker
      roleLabel={roleLabel}
      roleModelName={getRoleModel(current, role)?.name}
      onChoose={choose}
      {...(disabled === undefined ? {} : { disabled })}
    />
  );
}
