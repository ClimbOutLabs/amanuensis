/**
 * Every screenshot the help docs use, in the order they are taken. Each one is saved as
 * docs/screenshots/app/<name>-desktop.png and <name>-phone.png. To add one, add an entry here; if no step in
 * steps.ts reaches the screen, add one there.
 */
import {
  addConnector,
  ask,
  enableSkill,
  fill,
  fillPlaceholder,
  googleConnected,
  homeWithPill,
  open,
  openChat,
  openChatList,
  openMoreMenu,
  press,
  rowButton,
  see,
  settingsTab,
  type Step,
} from './steps.ts';

/**
 * How much of the demo world exists when the shot is taken: `empty` is a new sign-in with nothing set up,
 * `model` has only a model added, and `full` has everything in demoWorld.ts.
 */
export type World = 'empty' | 'model' | 'full';

export interface Shot {
  /** Lower-case words joined by hyphens, such as `memory-list`. */
  name: string;
  world: World;
  /** What to do, in order, to reach the screen. */
  steps: readonly Step[];
  /**
   * CSS selectors for the part of the screen to keep: the picture covers all of them together. Leave it out to
   * keep the whole window.
   */
  crop?: readonly string[];
}

const SETTINGS_PANEL = ['[role="tabpanel"]'];
const CARD = ['[data-role="approval-ticket"]'];
const DIALOG = ['dialog[open]'];
const HOME_CARDS = '[aria-labelledby="aman-home-cards-heading"]';

export const SHOTS: readonly Shot[] = [
  {
    name: 'first-steps-add-model',
    world: 'empty',
    steps: [settingsTab('Models'), rowButton({ row: 'together', button: 'Configure' }), see('Add provider')],
  },
  {
    name: 'first-steps-checklist',
    world: 'model',
    steps: [open('/'), see('Set up Aman')],
    crop: ['[data-testid="aman-setup-ticket"]', HOME_CARDS],
  },
  {
    name: 'ideas-cards',
    world: 'full',
    steps: [googleConnected, homeWithPill('Money'), see('What am I paying for every month?')],
    crop: ['ul[aria-label="What would help you most?"]', HOME_CARDS],
  },
  { name: 'chats-list', world: 'full', steps: [openChat('dinner'), openChatList] },
  {
    name: 'files-add-menu',
    world: 'full',
    steps: [openChat('dinner'), press('Add'), see('Attach files')],
    crop: ['[data-slot="aui_composer-root"]', '[role="menu"]'],
  },
  {
    name: 'daily-brief-list',
    world: 'full',
    steps: [openChat('morningBrief'), see('Needs a decision')],
    crop: ['[data-testid="aman-brief"]'],
  },
  { name: 'schedules-page', world: 'full', steps: [open('/schedules'), see('morning-brief')] },
  { name: 'spaces-list', world: 'full', steps: [open('/spaces'), see('Kitchen refresh')] },
  { name: 'memory-list', world: 'full', steps: [settingsTab('Memory'), see('Sam is vegetarian and loves Thai food.')] },
  { name: 'personalization-page', world: 'full', steps: [settingsTab('Personalization')], crop: SETTINGS_PANEL },
  { name: 'agents-build', world: 'full', steps: [open('/'), openMoreMenu, press('Start new agent')] },
  {
    name: 'skills-page',
    world: 'full',
    steps: [settingsTab('Skills'), enableSkill('algorithmic-art')],
    crop: SETTINGS_PANEL,
  },
  { name: 'appearance-themes', world: 'full', steps: [settingsTab('Themes')], crop: SETTINGS_PANEL },
  {
    name: 'appearance-more-menu',
    world: 'full',
    steps: [open('/'), openMoreMenu],
    crop: ['button[aria-label="More"]', '[role="menu"]'],
  },
  { name: 'connect-mail-calendar-connectors', world: 'full', steps: [settingsTab('Connectors')], crop: SETTINGS_PANEL },
  {
    name: 'google-setup',
    world: 'full',
    steps: [settingsTab('Connectors'), rowButton({ row: 'Google', button: 'Connect' })],
    crop: DIALOG,
  },
  {
    name: 'notes-folder-panel',
    world: 'full',
    steps: [
      settingsTab('Connectors'),
      rowButton({ row: 'Notes folder', button: 'Connect' }),
      fillPlaceholder({ placeholder: 'The path of your notes folder', value: '/Users/sam/Documents/Notes' }),
    ],
    crop: DIALOG,
  },
  {
    name: 'home-assistant-connect',
    world: 'full',
    steps: [
      settingsTab('Connectors'),
      rowButton({ row: 'home-assistant', button: 'Connect' }),
      fill({ label: /address/i, value: 'https://homeassistant.local:8123' }),
    ],
    crop: DIALOG,
  },
  {
    name: 'mcp-servers-catalog',
    world: 'full',
    steps: [
      addConnector({ name: 'parallel-web', description: 'Search the web.' }),
      settingsTab('Connectors'),
      press('Test the connection for parallel-web'),
      see(/^Connected$/),
    ],
    crop: SETTINGS_PANEL,
  },
  {
    name: 'permissions-settings',
    world: 'full',
    steps: [settingsTab('Permissions'), see('Offline mode')],
    crop: SETTINGS_PANEL,
  },
  { name: 'activity-log-list', world: 'full', steps: [settingsTab('Audit')], crop: SETTINGS_PANEL },
  // These make new chats, so they come after the chat list. The help chat comes last of all.
  {
    name: 'incognito-banner',
    world: 'full',
    steps: [ask('incognito', { incognito: true }), see('Close and delete')],
    crop: ['main'],
  },
  { name: 'calendar-event-card', world: 'full', steps: [ask('calendarEvent'), see(/to your calendar\?/)], crop: CARD },
  { name: 'approvals-card', world: 'full', steps: [ask('deletePlants'), see('Allow')], crop: CARD },
  {
    name: 'getting-help-guide',
    world: 'full',
    steps: [open('/'), press(/^Help(, I'm stuck)?$/), see('Pick one of the choices below')],
    // The reply, its choices and the message box; the request above it is the app's own check, not something to read.
    crop: ['text=Pick one of the choices below', 'button:has-text("Something else")', 'textarea'],
  },
];
