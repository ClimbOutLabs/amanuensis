'use client';

import { useTrueFoundryAgentSpec, useTrueFoundryUpdateAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { useEffect } from 'react';

import type { DraftPreferenceKind } from '../../server/draftSpecPreferences.js';
import { useServerCapabilities } from '../../server/ServerContext.js';
import { useShellMode } from '../../server/ShellModeContext.js';
import type { AgentSkill, AgentSpec, ConnectorState, ModelSelection } from '../../server/types.js';
import { mountName } from '../lib/mountName.js';
import { useDraftCatalog } from './DraftCatalogProvider.js';
import { modelPatchWithReasoningEffort } from './reasoningEffort.js';

function readDraftSandboxEnabled(spec: AgentSpec): boolean | undefined {
  if (spec.config === undefined) return undefined;
  // `sandbox` is draft runtime config and may be absent from AgentRuntimeConfig typings.
  const sandbox = Reflect.get(spec.config, 'sandbox');
  if (typeof sandbox !== 'object' || sandbox === null) return undefined;
  const enabled = Reflect.get(sandbox, 'enabled');
  return typeof enabled === 'boolean' ? enabled : undefined;
}

function filterMounts<T extends object>(mounts: T[] | undefined, availableNames: Set<string>): T[] | undefined {
  if (mounts === undefined) return undefined;
  const filtered = mounts.filter(mount => {
    const name = mountName(mount);
    return name !== null && availableNames.has(name);
  });
  return filtered.length === mounts.length ? mounts : filtered;
}

export function reconcileDraftSpecPreferences({
  agentSpec,
  models,
  skills,
  connectors,
  skillsEnabled,
}: {
  agentSpec: AgentSpec;
  models: ModelSelection[];
  skills: AgentSkill[];
  connectors: ConnectorState[];
  skillsEnabled: boolean | undefined;
}): Partial<AgentSpec> {
  const update: Partial<AgentSpec> = {};
  const selectedModel = agentSpec.model.name.trim();
  const selectedModelExists = selectedModel.length > 0 && models.some(model => model.name === selectedModel);
  if (!selectedModelExists) {
    // Empty selection, or a remembered model id whose provider is no longer
    // configured — fall back to the first available model rather than sending
    // with a stale id (which 422s as "Unknown model ... provider not configured").
    const fallback = models[0];
    if (fallback !== undefined) {
      update.model = modelPatchWithReasoningEffort(
        fallback.name,
        agentSpec.model.params,
        fallback.properties.reasoningEfforts,
      );
    }
  }

  const nextMcpServers = filterMounts(agentSpec.mcpServers, new Set(connectors.map(connector => connector.name)));
  if (nextMcpServers !== agentSpec.mcpServers) {
    update.mcpServers = nextMcpServers;
  }

  if (skillsEnabled === false) {
    // Only clear when there is something to clear — a fresh `[]` each call would
    // fail reference equality and loop `updateAgentSpec` forever.
    if (agentSpec.skills !== undefined && agentSpec.skills.length > 0) {
      update.skills = [];
    }
  } else {
    const nextSkills = filterMounts(agentSpec.skills, new Set(skills.map(skill => skill.name)));
    if (nextSkills !== agentSpec.skills) {
      update.skills = nextSkills;
    }
  }

  return update;
}

export function reconcileDraftSandbox({
  agentSpec,
  sandboxEnabled,
  kind = 'agent',
}: {
  agentSpec: AgentSpec;
  sandboxEnabled: boolean | null | undefined;
  kind?: DraftPreferenceKind;
}): Partial<AgentSpec> {
  if (kind === 'chat') {
    if (sandboxEnabled == null) return {};
    const current = readDraftSandboxEnabled(agentSpec);
    // The capability flag says the deployment offers a sandbox, not that the user
    // wants one, so it may only disable. Enabling from it would overwrite the
    // composer toggle every time the user turns the sandbox off.
    if (sandboxEnabled === false && current === true) {
      return {
        config: {
          ...agentSpec.config,
          sandbox: { ...agentSpec.config?.sandbox, enabled: false },
        },
      };
    }
    return {};
  }

  // For 'agent' kind: respect the user's explicit toggle choice. Do not force-disable
  // based on capabilities — the toggle's `disabled` state already prevents enabling
  // when unavailable. Overriding here causes the "toggle flips back" bug.
  return {};
}

/**
 * Mirrors plain-draft composer choices into the shell seed and removes skill or
 * connector entries that disappeared since those choices were stored. A
 * remembered model missing from the current catalog (e.g. its provider was
 * removed) falls back to the first available model once the catalog has
 * loaded, rather than sending with a stale id.
 * New Chat and New Agent keep separate seeds; chat never persists runtime config.
 */
export function DraftSpecPreferenceBridge() {
  const { mode, pendingSessionId, rememberDraftSpec } = useShellMode();
  const { agentSpec } = useTrueFoundryAgentSpec();
  const updateAgentSpec = useTrueFoundryUpdateAgentSpec();
  const capabilities = useServerCapabilities();
  const sandboxEnabled = capabilities?.sandbox.enabled;
  const { models, skills, connectors, loaded, error, ensureLoaded } = useDraftCatalog();
  const isPlainDraft = mode.status === 'active' && mode.isMutable && mode.agentId == null && pendingSessionId == null;
  const preferenceKind = mode.status === 'active' && mode.isMutable && mode.isCreateAgent ? 'agent' : 'chat';

  useEffect(() => {
    if (isPlainDraft) ensureLoaded();
  }, [ensureLoaded, isPlainDraft]);

  useEffect(() => {
    if (isPlainDraft && agentSpec != null) {
      rememberDraftSpec(agentSpec, preferenceKind);
    }
  }, [agentSpec, isPlainDraft, preferenceKind, rememberDraftSpec]);

  useEffect(() => {
    // A draft may not keep the sandbox on against a deployment that has none, since the run would fail at sandbox creation.
    if (!isPlainDraft || agentSpec == null || updateAgentSpec == null) return;
    const update = reconcileDraftSandbox({ agentSpec, sandboxEnabled, kind: preferenceKind });
    if (Object.keys(update).length > 0) {
      updateAgentSpec(update);
    }
  }, [agentSpec, isPlainDraft, preferenceKind, sandboxEnabled, updateAgentSpec]);

  useEffect(() => {
    if (!isPlainDraft || agentSpec == null || updateAgentSpec == null || !loaded || error != null) return;

    const update = reconcileDraftSpecPreferences({
      agentSpec,
      models,
      skills,
      connectors,
      skillsEnabled: capabilities?.skill.enabled,
    });
    if (Object.keys(update).length > 0) {
      updateAgentSpec(update);
    }
  }, [
    agentSpec,
    capabilities?.skill.enabled,
    connectors,
    error,
    isPlainDraft,
    loaded,
    models,
    skills,
    updateAgentSpec,
  ]);

  return null;
}
