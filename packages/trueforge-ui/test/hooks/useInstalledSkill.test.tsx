// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installedSkillName, removedSkillName, useInstalledSkill, useRemovedSkill } from '@/hooks/useInstalledSkill.js';

const state = vi.hoisted(() => ({
  skills: [{ id: 'web-artifacts-builder', name: 'web-artifacts-builder' }],
  chatSkills: [{ id: 'web-artifacts-builder', name: 'web-artifacts-builder' }],
  mutable: true,
  refresh: vi.fn(),
  updateAgentSpec: vi.fn(),
}));

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => ({ agentSpec: { skills: state.chatSkills } }),
  useTrueFoundryUpdateAgentSpec: () => state.updateAgentSpec,
}));
vi.mock('@/atoms/draft/DraftCatalogProvider.js', () => ({
  useDraftCatalog: () => ({ skills: state.skills, refresh: state.refresh }),
}));
vi.mock('@/server/ShellModeContext.js', () => ({
  useOptionalShellMode: () => ({ mode: { status: 'active', isMutable: state.mutable } }),
  shellIsMutable: (mode: { isMutable: boolean }) => mode.isMutable,
}));

const RESULT = JSON.stringify({ added: { name: 'release-notes', description: 'Writes release notes.' } });
const NEW_SKILL = { id: 'release-notes', name: 'release-notes' };
type Call = Parameters<typeof useInstalledSkill>[0];
const running: Call = { toolName: 'install_skill', complete: false, result: undefined };
const finished: Call = { toolName: 'install_skill', complete: true, result: RESULT };

beforeEach(() => {
  state.skills = [{ id: 'web-artifacts-builder', name: 'web-artifacts-builder' }];
  state.mutable = true;
  state.refresh.mockReset();
  state.updateAgentSpec.mockReset();
});

describe('installedSkillName', () => {
  it('reads the name however the result is wrapped', () => {
    expect(installedSkillName(RESULT)).toBe('release-notes');
    expect(installedSkillName({ added: { name: 'release-notes' } })).toBe('release-notes');
    expect(installedSkillName({ content: [{ type: 'text', text: RESULT }] })).toBe('release-notes');
  });

  it('reads nothing from a call that added nothing', () => {
    expect(installedSkillName(JSON.stringify({ error: 'Nothing was added.' }))).toBeUndefined();
    expect(installedSkillName({ isError: true, content: [{ type: 'text', text: RESULT }] })).toBeUndefined();
    expect(installedSkillName(undefined)).toBeUndefined();
    expect(installedSkillName('not json')).toBeUndefined();
  });
});

describe('useInstalledSkill', () => {
  it('turns the new skill on for this chat once the list of skills holds it', () => {
    const { rerender } = renderHook(props => useInstalledSkill(props), { initialProps: running });
    rerender(finished);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    // Until the list is read again the skill is not in it, and adding it early would be undone.
    expect(state.updateAgentSpec).not.toHaveBeenCalled();

    state.skills = [...state.skills, NEW_SKILL];
    rerender(finished);
    expect(state.updateAgentSpec).toHaveBeenCalledTimes(1);
    expect(state.updateAgentSpec).toHaveBeenCalledWith({ skills: [...state.chatSkills, NEW_SKILL] });
  });

  it('leaves a finished call in an old chat alone', () => {
    state.skills = [...state.skills, NEW_SKILL];
    const { rerender } = renderHook(props => useInstalledSkill(props), { initialProps: finished });
    rerender(finished);
    expect(state.refresh).not.toHaveBeenCalled();
    expect(state.updateAgentSpec).not.toHaveBeenCalled();
  });

  it('does nothing for a call that was refused, or for another tool', () => {
    const refused = { ...finished, result: JSON.stringify({ error: 'Nothing was added.' }) };
    const first = renderHook(props => useInstalledSkill(props), { initialProps: running });
    first.rerender(refused);
    const other = renderHook(props => useInstalledSkill(props), {
      initialProps: { ...running, toolName: 'create_persona' },
    });
    other.rerender({ ...finished, toolName: 'create_persona' });
    expect(state.refresh).not.toHaveBeenCalled();
    expect(state.updateAgentSpec).not.toHaveBeenCalled();
  });

  it('does not change a chat whose setup cannot be changed', () => {
    state.mutable = false;
    const { rerender } = renderHook(props => useInstalledSkill(props), { initialProps: running });
    rerender(finished);
    state.skills = [...state.skills, NEW_SKILL];
    rerender(finished);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.updateAgentSpec).not.toHaveBeenCalled();
  });
});

describe('useRemovedSkill', () => {
  const REMOVED = JSON.stringify({ removed: { name: 'web-artifacts-builder' } });
  const removing: Call = { toolName: 'remove_skill', complete: false, result: undefined };
  const removed: Call = { toolName: 'remove_skill', complete: true, result: REMOVED };

  it('reads the removed name, and nothing from a refused call', () => {
    expect(removedSkillName(REMOVED)).toBe('web-artifacts-builder');
    expect(removedSkillName(JSON.stringify({ error: 'Nothing was removed.' }))).toBeUndefined();
    expect(removedSkillName(RESULT)).toBeUndefined();
  });

  it('takes the skill out of this chat and reads the skill lists again', () => {
    const { rerender } = renderHook(props => useRemovedSkill(props), { initialProps: removing });
    rerender(removed);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.updateAgentSpec).toHaveBeenCalledWith({ skills: [] });
  });

  it('leaves a finished call in an old chat alone', () => {
    const { rerender } = renderHook(props => useRemovedSkill(props), { initialProps: removed });
    rerender(removed);
    expect(state.refresh).not.toHaveBeenCalled();
    expect(state.updateAgentSpec).not.toHaveBeenCalled();
  });

  it('does not change a chat whose setup cannot be changed', () => {
    state.mutable = false;
    const { rerender } = renderHook(props => useRemovedSkill(props), { initialProps: removing });
    rerender(removed);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.updateAgentSpec).not.toHaveBeenCalled();
  });
});
