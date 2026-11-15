/**
 * The screens the weekly look-over opens, beyond the Settings tabs it finds on its own. To cover a new screen,
 * add an entry here; if no step in docsScreenshots/steps.ts reaches it, add one there.
 */
import {
  ask,
  googleConnected,
  homeWithPill,
  open,
  openChat,
  openChatList,
  openForYou,
  openMoreMenu,
  openReminders,
  press,
  rowButton,
  see,
  settingsTab,
  type Step,
} from '../docsScreenshots/steps.ts';

export interface Surface {
  /** Lower-case words joined by hyphens, such as `chat-list`. */
  name: string;
  /** What to do, in order, to reach the screen. */
  steps: readonly Step[];
}

/** Opens the first thing with this text, such as a row in a list. */
function choose(text: string): Step {
  return async ({ page }) => {
    const target = page.getByText(text, { exact: true }).locator('visible=true').first();
    await target.waitFor({ state: 'visible' });
    await target.click();
  };
}

export const SURFACES: readonly Surface[] = [
  { name: 'home', steps: [open('/')] },
  { name: 'home-ideas', steps: [googleConnected, homeWithPill('Money'), see('What am I paying for every month?')] },
  { name: 'chat', steps: [openChat('dinner')] },
  { name: 'chat-long-answer', steps: [openChat('lisbon')] },
  { name: 'chat-brief', steps: [openChat('morningBrief'), see('Needs a decision')] },
  { name: 'chat-list', steps: [openChat('dinner'), openChatList] },
  { name: 'chat-add-menu', steps: [openChat('dinner'), press('Add'), see('Attach files')] },
  { name: 'more-menu', steps: [open('/'), openMoreMenu] },
  { name: 'for-you', steps: [openChat('dinner'), openForYou] },
  { name: 'reminders', steps: [openReminders, see("Book Pepper's checkup")] },
  { name: 'schedules', steps: [open('/schedules'), see('morning-brief')] },
  { name: 'spaces', steps: [open('/spaces'), see('Kitchen refresh')] },
  { name: 'space-open', steps: [open('/spaces'), choose('Kitchen refresh')] },
  { name: 'agent-new', steps: [open('/'), openMoreMenu, press('Start new agent')] },
  { name: 'agents-library', steps: [open('/library')] },
  { name: 'all-chats', steps: [open('/sessions')] },
  { name: 'live-browser', steps: [open('/browser-live')] },
  { name: 'connect-google', steps: [settingsTab('Connectors'), rowButton({ row: 'Google', button: 'Connect' })] },
  { name: 'add-model', steps: [settingsTab('Models'), rowButton({ row: 'together', button: 'Configure' })] },
  // These make new chats, so they come after the chat list. The help chat comes last of all.
  { name: 'incognito-chat', steps: [ask('incognito', { incognito: true }), see('Close and delete')] },
  { name: 'approval-card', steps: [ask('deletePlants'), see('Allow')] },
  { name: 'calendar-card', steps: [ask('calendarEvent'), see(/to your Google Calendar on/)] },
  { name: 'help', steps: [open('/'), press(/^Help(, I'm stuck)?$/), see('Pick one of the choices below')] },
];
