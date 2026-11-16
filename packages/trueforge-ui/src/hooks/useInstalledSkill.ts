'use client';

import { useTrueFoundryAgentSpec, useTrueFoundryUpdateAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { INSTALL_SKILL_TOOL_NAME, REMOVE_SKILL_TOOL_NAME } from '@truefoundry/trueforge-core/core/skills/toolContract';
import { useEffect, useRef, useState } from 'react';

import { useDraftCatalog } from '../atoms/draft/DraftCatalogProvider.js';
import { mountName } from '../atoms/lib/mountName.js';
import { shellIsMutable, useOptionalShellMode } from '../server/ShellModeContext.js';

const MAX_RESULT_DEPTH = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Which part of a finished skill call's result names the skill: added for an install, removed for a removal. */
type SkillResultKey = 'added' | 'removed';

/**
 * The name of the skill a finished skill call added or removed, read from its result however the result is
 * wrapped. Undefined for a call that changed nothing, such as one that was refused.
 */
function skillNameIn({
  result,
  key,
  depth,
}: {
  result: unknown;
  key: SkillResultKey;
  depth: number;
}): string | undefined {
  if (depth > MAX_RESULT_DEPTH) return undefined;
  if (typeof result === 'string') {
    try {
      const parsed: unknown = JSON.parse(result);
      return typeof parsed === 'string' ? undefined : skillNameIn({ result: parsed, key, depth: depth + 1 });
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(result)) {
    for (const item of result) {
      const name = skillNameIn({ result: item, key, depth: depth + 1 });
      if (name !== undefined) return name;
    }
    return undefined;
  }
  if (!isRecord(result)) return undefined;
  if (result.isError === true || result.error !== undefined) return undefined;
  const changed = result[key];
  if (isRecord(changed) && typeof changed.name === 'string') return changed.name;
  for (const nested of ['result', 'content', 'text']) {
    const name = skillNameIn({ result: result[nested], key, depth: depth + 1 });
    if (name !== undefined) return name;
  }
  return undefined;
}

/** The name of the skill a finished install_skill call added. */
export function installedSkillName(result: unknown): string | undefined {
  return skillNameIn({ result, key: 'added', depth: 0 });
}

/** The name of the skill a finished remove_skill call removed. */
export function removedSkillName(result: unknown): string | undefined {
  return skillNameIn({ result, key: 'removed', depth: 0 });
}

/**
 * Turns a skill on for the chat it was just added from, so it is ready on the next message. Only a call
 * that finishes while it is on screen counts: a finished call in an old chat is history, and turning its
 * skill back on would undo the person's later choice to turn it off.
 */
export function useInstalledSkill(part: { toolName: string; complete: boolean; result: unknown }): void {
  const { skills, refresh } = useDraftCatalog();
  const { agentSpec } = useTrueFoundryAgentSpec();
  const updateAgentSpec = useTrueFoundryUpdateAgentSpec();
  const mode = useOptionalShellMode()?.mode;
  const wasComplete = useRef(part.complete);
  const [pending, setPending] = useState<string | null>(null);

  const finishedName =
    part.toolName === INSTALL_SKILL_TOOL_NAME && part.complete ? installedSkillName(part.result) : undefined;
  useEffect(() => {
    if (wasComplete.current || finishedName === undefined) return;
    wasComplete.current = true;
    setPending(finishedName);
    // The pickers and the list of skills a chat may use were read before this skill existed.
    refresh();
  }, [finishedName, refresh]);

  const listed = pending === null ? undefined : skills.find(skill => skill.name === pending);
  const canUpdateChat = mode !== undefined && shellIsMutable(mode) && agentSpec != null && updateAgentSpec != null;
  useEffect(() => {
    if (listed === undefined || !canUpdateChat) return;
    const current = agentSpec.skills ?? [];
    if (!current.some(skill => mountName(skill) === listed.name)) {
      updateAgentSpec({ skills: [...current, listed] });
    }
    setPending(null);
  }, [listed, canUpdateChat, agentSpec, updateAgentSpec]);
}

/**
 * Takes a skill that was just removed from a chat out of that chat's setup and the skill lists, so the pickers
 * stop offering it. A finished call in an old chat is history and changes nothing.
 */
export function useRemovedSkill(part: { toolName: string; complete: boolean; result: unknown }): void {
  const { refresh } = useDraftCatalog();
  const { agentSpec } = useTrueFoundryAgentSpec();
  const updateAgentSpec = useTrueFoundryUpdateAgentSpec();
  const mode = useOptionalShellMode()?.mode;
  const wasComplete = useRef(part.complete);

  const removedName =
    part.toolName === REMOVE_SKILL_TOOL_NAME && part.complete ? removedSkillName(part.result) : undefined;
  const canUpdateChat = mode !== undefined && shellIsMutable(mode) && agentSpec != null && updateAgentSpec != null;
  useEffect(() => {
    if (wasComplete.current || removedName === undefined) return;
    wasComplete.current = true;
    refresh();
    if (!canUpdateChat) return;
    const current = agentSpec.skills ?? [];
    if (current.some(skill => mountName(skill) === removedName)) {
      updateAgentSpec({ skills: current.filter(skill => mountName(skill) !== removedName) });
    }
  }, [removedName, refresh, canUpdateChat, agentSpec, updateAgentSpec]);
}
