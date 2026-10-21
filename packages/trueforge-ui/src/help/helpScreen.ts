import type { SettingsSection } from '../server/ShellModeContext.js';

/** The names the Settings page shows for each section, so "You were on" uses the words the person sees. */
const SETTINGS_SECTION_NAMES: Record<SettingsSection, string> = {
  models: 'Models',
  'model-roles': 'Roles and Personas',
  connectors: 'Connectors',
  memory: 'Memory',
  skills: 'Skills',
  sandbox: 'Sandbox',
  personalization: 'Personalization',
  themes: 'Themes',
  permissions: 'Permissions',
  audit: 'Audit',
};

export interface HelpScreenState {
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  libraryOpen: boolean;
  sessionsOpen: boolean;
  schedulesOpen: boolean;
  spacesOpen: boolean;
}

/** A plain name for the screen the person is on, such as "Settings, Connectors" or "Chat". */
export function describeHelpScreen(state: HelpScreenState | null): string {
  if (state === null) {
    return 'Chat';
  }
  if (state.settingsOpen) {
    return `Settings, ${SETTINGS_SECTION_NAMES[state.settingsSection]}`;
  }
  if (state.schedulesOpen) {
    return 'Schedules';
  }
  if (state.spacesOpen) {
    return 'Spaces';
  }
  if (state.libraryOpen) {
    return 'Agent library';
  }
  if (state.sessionsOpen) {
    return 'Sessions';
  }
  return 'Chat';
}
