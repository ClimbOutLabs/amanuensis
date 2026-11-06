import { DEFAULT_NEW_CHAT_SKILLS } from '@truefoundry/trueforge-core/agent-session/newChatDefaults';

import type { AgentSkill } from './types.js';

/**
 * Skills a brand-new chat starts with, before the user customises anything: the names a new chat starts with
 * everywhere, as the app's skill references. Every seed `AgentSpec` (the app boot default in
 * `packages/frontend/src/App.tsx` and the `FALLBACK_MUTABLE_SPEC` in `ShellModeContext.tsx`) spreads this in rather
 * than hardcoding its own list.
 *
 * Skills need the sandbox, so when the sandbox capability is off, the existing skill-availability filter
 * (`reconcileDraftSpecPreferences` in `atoms/draft/DraftSpecPreferenceBridge.tsx`) drops them the same way it drops
 * any other unmounted skill, and nothing here forces the sandbox on.
 */
export const DEFAULT_AGENT_SPEC_SKILLS: readonly AgentSkill[] = DEFAULT_NEW_CHAT_SKILLS.map(name => ({
  id: name,
  name,
}));
