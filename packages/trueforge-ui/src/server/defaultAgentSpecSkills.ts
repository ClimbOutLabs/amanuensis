import type { AgentSkill } from './types.js';

/**
 * Skills a brand-new chat starts with, before the user customises anything. The single source of
 * truth: every seed `AgentSpec` (the app boot default in `packages/frontend/src/App.tsx` and the
 * `FALLBACK_MUTABLE_SPEC` in `ShellModeContext.tsx`) spreads this in rather than hardcoding its
 * own list.
 *
 * `web-artifacts-builder` (Anthropic's skill for self-contained HTML/JS/CSS artifacts) guides the
 * model in authoring a designed, self-contained page — including an html-format space. It is
 * referenced by name only: skills need the sandbox, so when the sandbox capability is off, the
 * existing skill-availability filter (`reconcileDraftSpecPreferences` in
 * `atoms/draft/DraftSpecPreferenceBridge.tsx`) drops it the same way it drops any other unmounted
 * skill, and nothing here forces the sandbox on.
 */
export const DEFAULT_AGENT_SPEC_SKILLS: readonly AgentSkill[] = [
  { id: 'web-artifacts-builder', name: 'web-artifacts-builder' },
];
