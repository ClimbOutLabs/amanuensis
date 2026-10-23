import type { ShellModeContextValue } from '../server/ShellModeContext.js';

export type RailEntry = 'chats' | 'spaces' | 'schedules' | 'agents' | 'more';

type RailShellState = Pick<
  ShellModeContextValue,
  'settingsOpen' | 'sessionsOpen' | 'libraryOpen' | 'schedulesOpen' | 'spacesOpen' | 'mode'
>;

/**
 * The one rail entry that shows as the current screen. A page reached from inside another (a
 * schedule, an agent's details, a settings section, the agent builder) lights its parent, so
 * exactly one entry is highlighted on every screen.
 */
export function railEntryFor(shell: RailShellState | null): RailEntry {
  if (shell === null) return 'chats';
  if (shell.settingsOpen || shell.sessionsOpen) return 'more';
  if (shell.libraryOpen) return 'agents';
  if (shell.schedulesOpen) return 'schedules';
  if (shell.spacesOpen) return 'spaces';
  // Build agent lives under More, so the agent builder lights More.
  if (shell.mode.status === 'active' && shell.mode.isCreateAgent) return 'more';
  // Only the agent-library modes have no chat open; their landing page picks an agent.
  if (shell.mode.status === 'idle') return 'agents';
  return 'chats';
}
