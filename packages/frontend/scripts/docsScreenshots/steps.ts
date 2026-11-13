/** The small actions a shot takes to reach its screen. A new shot reuses these, or adds one more here. */
import type { Locator, Page } from 'playwright-core';

import type { ApprovalTestServer } from '../../../trueforge/tests/fixtures/approvalTestServer.ts';
import { CHATS, type ChatKey, type DemoChat } from './demoWorld.ts';
import { askInNewChat, composer, type OwnerApi } from './seed.ts';

export const STEP_TIMEOUT_MS = 45_000;

export interface StepContext {
  page: Page;
  origin: string;
  /** True for the phone size, where some controls sit behind a menu. */
  phone: boolean;
  api: ApprovalTestServer;
  owner: OwnerApi;
}

export type Step = (context: StepContext) => Promise<void>;

async function shows(target: Locator): Promise<void> {
  await target.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Opens a page of the app by its address, such as `/` or `/schedules`. */
export function open(path: string): Step {
  return async ({ page, origin }) => {
    await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_MS * 2 });
  };
}

/** Waits until this text is on screen. */
export function see(text: string | RegExp): Step {
  return async ({ page }) => {
    await shows(page.getByText(text));
  };
}

/** Scrolls until this text is in view. */
export function scrollTo(text: string | RegExp): Step {
  return async ({ page }) => {
    const target = page.getByText(text).first();
    await shows(target);
    await target.scrollIntoViewIfNeeded();
  };
}

/** Clicks a button by its visible name or label. */
export function press(name: string | RegExp): Step {
  return async ({ page }) => {
    const button = page.getByRole('button', { name, exact: typeof name === 'string' });
    await shows(button);
    await button.first().click();
  };
}

/** Types into the field with this label. */
export function fill({ label, value }: { label: string | RegExp; value: string }): Step {
  return async ({ page }) => {
    const field = page.getByLabel(label).first();
    await shows(field);
    await field.fill(value);
  };
}

/** Types into the field that shows this placeholder. */
export function fillPlaceholder({ placeholder, value }: { placeholder: string; value: string }): Step {
  return async ({ page }) => {
    const field = page.getByPlaceholder(placeholder).first();
    await shows(field);
    await field.fill(value);
  };
}

/** Opens a chat the run made earlier, by its title. */
export function openChat(key: ChatKey): Step {
  return async context => {
    const listed = await context.owner.call({ method: 'GET', path: '/api/v1/sessions?limit=25' });
    const list = isRecord(listed) && Array.isArray(listed['data']) ? listed['data'] : [];
    const found: unknown = list.find(item => isRecord(item) && item['title'] === CHATS[key].title);
    if (!isRecord(found) || typeof found['id'] !== 'string') throw new Error(`The demo chat "${key}" was not made.`);
    await open(`/sessions/${found['id']}`)(context);
    await shows(composer(context.page));
  };
}

/**
 * Asks a demo question in a new chat and gives it its demo title. A chat that ends on a card leaves its last card
 * waiting. The same chat from the other size is deleted first, so the chat list shows each one once.
 */
export function ask(key: ChatKey, options?: { incognito?: boolean }): Step {
  const chat: DemoChat = CHATS[key];
  const incognito = options?.incognito === true;
  return async ({ api, page, origin, owner }) => {
    const listed = await owner.call({ method: 'GET', path: '/api/v1/sessions?limit=25' });
    const list = isRecord(listed) && Array.isArray(listed['data']) ? listed['data'] : [];
    for (const item of list) {
      if (isRecord(item) && item['title'] === chat.title && typeof item['id'] === 'string') {
        await owner.call({ method: 'DELETE', path: `/api/v1/sessions/${item['id']}` });
      }
    }
    const id = await askInNewChat({
      api,
      page,
      origin,
      key,
      leaveWaiting: (chat.tools ?? []).length > 0,
      incognito,
      decline: false,
    });
    if (!incognito) await owner.call({ method: 'PATCH', path: `/api/v1/sessions/${id}`, body: { title: chat.title } });
  };
}

/** Opens home and chooses one of the "What would help you most?" pills. */
export function homeWithPill(label: string): Step {
  return async context => {
    await open('/')(context);
    const pills = context.page.getByRole('list', { name: 'What would help you most?' });
    await shows(pills);
    const pill = pills.getByRole('button', { name: label, exact: true });
    if ((await pill.getAttribute('aria-pressed')) !== 'true') await pill.click();
    await shows(context.page.locator('[aria-labelledby="aman-home-cards-heading"] li'));
  };
}

/** Opens Settings on one tab, named as the tab strip shows it. */
export function settingsTab(label: string): Step {
  return async context => {
    await open('/settings')(context);
    const tablist = context.page.getByRole('tablist', { name: 'Settings sections' });
    await shows(tablist);
    await tablist.getByRole('tab', { name: label, exact: true }).click();
    await shows(context.page.getByRole('tabpanel'));
  };
}

/** Presses a button in the smallest box that holds both this exact text and the button, such as a list row. */
export function rowButton({ row, button }: { row: string; button: string }): Step {
  return async ({ page }) => {
    const label = page.getByText(row, { exact: true }).first();
    await shows(label);
    const target = page.getByRole('button', { name: button, exact: true });
    const box = page.locator('li, div, article, section').filter({ has: label }).filter({ has: target }).last();
    const pressed = box.getByRole('button', { name: button, exact: true }).first();
    await pressed.scrollIntoViewIfNeeded();
    await pressed.click();
  };
}

/** Turns on one skill. The phone shot comes after the computer one, when it is already on. */
export function enableSkill(name: string): Step {
  return async ({ page }) => {
    await shows(page.getByText(name, { exact: true }));
    const enable = page.getByRole('button', { name: `Enable ${name}`, exact: true });
    if ((await enable.count()) === 0) return;
    await enable.first().click();
    await enable.first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  };
}

/** Opens the More menu in the left bar, or the bottom bar on a phone. */
export const openMoreMenu: Step = async context => {
  const { page } = context;
  if (context.phone) await press('Navigation')(context);
  const more = page.getByRole('button', { name: 'More', exact: true });
  await shows(more);
  await more.first().click();
  await shows(page.getByRole('menu'));
};

/** Opens the For you panel from the bell in the left panel, after the menu button on a phone. */
export const openForYou: Step = async context => {
  if (context.phone) await press(/^Navigation/)(context);
  await press(/^For you/)(context);
  await shows(context.page.getByRole('dialog', { name: 'For you' }).getByText('Call the pharmacy'));
};

/** Opens the Reminders page from the left panel, after the menu button on a phone. */
export const openReminders: Step = async context => {
  await open('/')(context);
  if (context.phone) await press(/^Navigation/)(context);
  await press('Reminders')(context);
};

/** Picks a tab inside the page, such as Personas on the Roles and Personas page. */
export function pickTab(name: string): Step {
  return async ({ page }) => {
    const tab = page.getByRole('tabpanel').getByRole('tab', { name, exact: true });
    await shows(tab);
    await tab.first().click();
  };
}

/**
 * Opens the chat list with its Earlier group unfolded: the Chats button in the left bar, or the menu button and
 * then Chats on a phone. The Chats button also folds the list away, so it is pressed only when the list is shut.
 */
export const openChatList: Step = async context => {
  const { page } = context;
  if (context.phone) await press('Navigation')(context);
  const chats = page.getByRole('button', { name: 'Chats', exact: true }).locator('visible=true');
  await shows(chats);
  if ((await page.getByLabel('Recent chats').locator('visible=true').count()) === 0) await chats.first().click();
  const earlier = page.getByRole('button', { name: 'Earlier', exact: true }).locator('visible=true');
  await shows(earlier);
  if ((await earlier.first().getAttribute('aria-expanded')) !== 'true') await earlier.first().click();
};

/** Answers the Google status read as an account with mail and calendar granted, for screens that change with it. */
export const googleConnected: Step = async ({ page, origin }) => {
  const response = await page.request.get(`${origin}/api/v1/user/settings/google/status`);
  const body: unknown = await response.json();
  const data = isRecord(body) ? body['data'] : undefined;
  if (!isRecord(data) || !Array.isArray(data['features'])) throw new Error('The Google status has no features.');
  const features: unknown[] = data['features'];
  const connected = {
    data: {
      ...data,
      state: 'connected',
      features: features.map(item => (isRecord(item) ? { ...item, granted: true } : item)),
    },
  };
  await page.route('**/api/v1/user/settings/google/status', route => route.fulfill({ json: connected }));
};

/** Adds a working connector, served on this machine, under a catalog connector's name. */
export function addConnector({ name, description }: { name: string; description: string }): Step {
  return async ({ api, owner }) => {
    const listed = await owner.call({ method: 'GET', path: '/api/v1/settings/mcp-servers' });
    if (JSON.stringify(listed).includes(`"name":"${name}"`)) return;
    await owner.call({
      method: 'POST',
      path: '/api/v1/settings/mcp-servers',
      body: { manifest: { type: 'remote', name, url: api.mcp.url, description } },
    });
  };
}
