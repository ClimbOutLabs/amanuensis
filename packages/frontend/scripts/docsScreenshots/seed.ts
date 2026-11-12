/** Fills a fresh server with the demo world, through the same API and screens a person would use. */
import { setTimeout as delay } from 'node:timers/promises';

import type { Page } from 'playwright-core';

import { TENANT_ID } from '../../../trueforge/src/apis/sessions.ts';
import { DeliveryStore } from '../../../trueforge/src/db/deliveryStore.ts';
import { formatRunTime } from '../../../trueforge/src/runtime/scheduleCapability.ts';
import type { ApprovalTestServer } from '../../../trueforge/tests/fixtures/approvalTestServer.ts';
import {
  CHAT_FOLDER,
  CHATS,
  DUE_REMINDER,
  MAILBOX_CHATS,
  MAIN_MODEL,
  MEMORIES,
  OWNER,
  OWNER_PASSWORD,
  PAUSED_SCHEDULE,
  PERSONAS,
  PROFILE,
  PROVIDER,
  RUN_SCHEDULES,
  SEEDED_CHATS,
  SPACE_FOLDER,
  SPACES,
  TIME_ZONE,
  type ChatKey,
  type DemoChat,
} from './demoWorld.ts';

const STEP_TIMEOUT_MS = 45_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** What the test fixture adds on its own, which no screenshot may show. */
const FIXTURE_PROVIDER = 'scripted';
const FIXTURE_CONNECTOR = 'inert';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field of an API answer's `data`. */
function dataField({ answer, field }: { answer: unknown; field: string }): string {
  const data = isRecord(answer) ? answer['data'] : undefined;
  const value = isRecord(data) ? data[field] : undefined;
  if (typeof value !== 'string') throw new Error(`The server's answer has no ${field}.`);
  return value;
}

/** The API, signed in as the owner. */
export interface OwnerApi {
  /** The owner's sign-in cookie, for the browser. */
  cookie: { name: string; value: string };
  call: (input: { method: string; path: string; body?: unknown }) => Promise<unknown>;
}

/** Creates the owner's sign-in, as the first-run form does, and keeps the cookie it sets. */
export async function signUpOwner(api: ApprovalTestServer): Promise<OwnerApi> {
  const form = new URLSearchParams({
    email: OWNER.email,
    password: OWNER_PASSWORD,
    password_confirm: OWNER_PASSWORD,
    return_to: '/',
  });
  const created = await api.request('/api/v1/auth/create-account', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: form.toString(),
  });
  const match = /(?:^|,\s*)(id_token)=([^;]+)/.exec(created.headers.get('set-cookie') ?? '');
  const [, name, value] = match ?? [];
  if (name === undefined || value === undefined) {
    throw new Error(`The demo sign-in was not created (${String(created.status)}): ${await created.text()}`);
  }
  const call: OwnerApi['call'] = async ({ method, path, body }) => {
    const response = await api.request(path, {
      method,
      headers: {
        cookie: `${name}=${value}`,
        'sec-fetch-site': 'same-origin',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} failed (${String(response.status)}): ${text}`);
    return text === '' ? undefined : JSON.parse(text);
  };
  return { cookie: { name, value }, call };
}

/** Takes away the model and connector the test server adds on its own, so the app starts empty. */
export async function removeFixtureExtras(owner: OwnerApi): Promise<void> {
  await owner.call({ method: 'DELETE', path: `/api/v1/settings/model-providers/${FIXTURE_PROVIDER}` });
  await owner.call({ method: 'DELETE', path: `/api/v1/settings/mcp-servers/${FIXTURE_CONNECTOR}` });
}

/** Adds the demo model provider, the one thing a first run needs. */
export async function seedModel({ owner, modelBaseUrl }: { owner: OwnerApi; modelBaseUrl: string }): Promise<void> {
  await owner.call({
    method: 'POST',
    path: '/api/v1/settings/model-providers',
    body: {
      manifest: {
        type: PROVIDER.type,
        base_url: modelBaseUrl,
        auth: { api_key: 'demo-key' },
        models: PROVIDER.models.map(model => ({
          ...model,
          properties: { context_length: 131072, max_output_tokens: 8192, max_concurrent_requests: 4 },
        })),
      },
    },
  });
}

/** The profile, personas, memories and spaces. */
export async function seedSettings(owner: OwnerApi): Promise<void> {
  await owner.call({ method: 'PUT', path: '/api/v1/personalization/profile', body: { profile: PROFILE } });
  for (const persona of PERSONAS) {
    await owner.call({
      method: 'POST',
      path: '/api/v1/personas',
      body: { persona: { ...persona, model_name: MAIN_MODEL } },
    });
  }
  const namespaces = new Set(MEMORIES.map(memory => memory.persona));
  for (const persona of namespaces) {
    await owner.call({
      method: 'POST',
      path: '/api/v1/memory/vault/import',
      body: {
        ...(persona === undefined ? {} : { namespace: `persona:${persona}` }),
        entries: MEMORIES.filter(memory => memory.persona === persona).map(memory => ({
          text: memory.text,
          timestamp: new Date(Date.now() - memory.daysAgo * DAY_MS).toISOString(),
        })),
      },
    });
  }

  const folder = dataField({
    answer: await owner.call({ method: 'POST', path: '/api/v1/space-folders', body: { name: SPACE_FOLDER } }),
    field: 'id',
  });
  for (const space of SPACES) {
    const listed = await owner.call({ method: 'GET', path: '/api/v1/spaces' });
    const revision = isRecord(listed) && isRecord(listed['data']) ? listed['data']['aggregate_revision'] : undefined;
    const created = await owner.call({
      method: 'POST',
      path: '/api/v1/spaces',
      body: {
        space: { name: space.name, purpose: space.purpose, body: space.body, status: 'active' },
        expected_aggregate_revision: typeof revision === 'number' ? revision : 0,
      },
    });
    if (space.folder) {
      const data = isRecord(created) ? created['data'] : undefined;
      const id = isRecord(data) && isRecord(data['space']) ? data['space']['id'] : undefined;
      if (typeof id !== 'string') throw new Error(`The space "${space.name}" was saved without an id.`);
      await owner.call({ method: 'PUT', path: `/api/v1/spaces/${id}/folder`, body: { folder_id: folder } });
    }
  }
}

export function composer(page: Page) {
  return page.locator('[data-slot="aui_composer-input"]').first();
}

/**
 * Asks one demo question from a new chat, the way Sam would type it. Cards along the way are allowed,
 * except the last one when `leaveWaiting` is set, which stays on screen. Returns the chat's id.
 */
export async function askInNewChat({
  api,
  page,
  origin,
  key,
  leaveWaiting,
  incognito,
  decline,
}: {
  api: ApprovalTestServer;
  page: Page;
  origin: string;
  key: ChatKey;
  leaveWaiting: boolean;
  incognito: boolean;
  /** Answers the last card with Not now instead of Allow. */
  decline: boolean;
}): Promise<string> {
  const chat: DemoChat = CHATS[key];
  // Email and calendar tools need an account. The practice mailbox stands in for Sam's while this chat runs.
  api.setEvalMode(MAILBOX_CHATS.includes(key));
  try {
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await composer(page).waitFor({ timeout: STEP_TIMEOUT_MS * 2 });
    if (incognito) await page.getByRole('button', { name: 'Start incognito chat' }).click();
    await composer(page).fill(chat.ask);
    await composer(page).press('Enter');
    await page.waitForURL(/\/sessions\/[^/?#]+/, { timeout: STEP_TIMEOUT_MS });
    const id = /\/sessions\/([^/?#]+)/.exec(page.url())?.[1];
    if (id === undefined) throw new Error(`The chat address ${page.url()} has no chat id.`);
    const main = page.locator('main');
    const allow = main.getByRole('button', { name: 'Allow', exact: true });
    const cards = (chat.tools ?? []).filter(tool => tool.match !== 'set_reminder').length;
    for (let index = 0; index < cards; index += 1) {
      await allow.first().waitFor({ timeout: STEP_TIMEOUT_MS });
      if (leaveWaiting && index === cards - 1) return id;
      if (decline && index === cards - 1)
        await main.getByRole('button', { name: 'Not now', exact: true }).first().click();
      else await allow.first().click();
      await allow.first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
    }
    const firstLine = chat.reply.split('\n').find(line => line.trim() !== '') ?? chat.reply;
    await main
      .getByText(chat.shows ?? firstLine.replace(/\*\*/g, ''))
      .first()
      .waitFor({ timeout: STEP_TIMEOUT_MS });
    return id;
  } finally {
    api.setEvalMode(false);
  }
}

/** Moves a chat back in time, so the chat list sorts it under an earlier day. */
async function backdate({ api, id, daysAgo }: { api: ApprovalTestServer; id: string; daysAgo: number }): Promise<void> {
  if (daysAgo === 0) return;
  const row = await api
    .db()
    .selectFrom('session')
    .select(['created_at'])
    .where('session_id', '=', id)
    .executeTakeFirst();
  if (row === undefined) throw new Error(`The chat ${id} is not in the database.`);
  const when = new Date(Date.now() - daysAgo * DAY_MS);
  // Keep the stored format, which is either ISO time or SQLite's "YYYY-MM-DD HH:MM:SS".
  const stamp = row.created_at.includes('T') ? when.toISOString() : when.toISOString().replace('T', ' ').slice(0, 19);
  await api
    .db()
    .updateTable('session')
    .set({ created_at: stamp, updated_at: stamp, last_activity_timestamp_ms: when.getTime() })
    .where('session_id', '=', id)
    .execute();
}

/**
 * Deletes the chats the schedule runs opened. They are titled with the whole task and labelled with the agent's
 * inner name, which would crowd the chat list; the runs themselves stay on the Schedules page.
 */
async function removeRunChats(owner: OwnerApi): Promise<void> {
  const known = new Set(Object.values(CHATS).map(chat => chat.title));
  const deadline = Date.now() + STEP_TIMEOUT_MS * 2;
  let removed = 0;
  while (removed < RUN_SCHEDULES.length) {
    if (Date.now() > deadline) throw new Error('The schedule runs did not open their chats in time.');
    const listed = await owner.call({ method: 'GET', path: '/api/v1/sessions?limit=25' });
    const list = isRecord(listed) && Array.isArray(listed['data']) ? listed['data'] : [];
    for (const item of list) {
      if (!isRecord(item) || typeof item['id'] !== 'string' || known.has(String(item['title']))) continue;
      // A run still answering cannot be deleted yet, so this is tried again on the next pass.
      const gone = await owner
        .call({ method: 'DELETE', path: `/api/v1/sessions/${item['id']}` })
        .then(() => true)
        .catch(() => false);
      if (gone) removed += 1;
    }
    await delay(1000);
  }
}

/** Makes the demo chats, files two in a folder, pauses one schedule and leaves one reminder due. */
export async function seedChats({
  api,
  owner,
  page,
  origin,
}: {
  api: ApprovalTestServer;
  owner: OwnerApi;
  page: Page;
  origin: string;
}): Promise<void> {
  const folder = dataField({
    answer: await owner.call({ method: 'POST', path: '/api/v1/session-folders', body: { name: CHAT_FOLDER } }),
    field: 'id',
  });
  for (const seeded of SEEDED_CHATS) {
    const id = await askInNewChat({
      api,
      page,
      origin,
      key: seeded.key,
      leaveWaiting: false,
      incognito: false,
      decline: seeded.decline === true,
    });
    await owner.call({ method: 'PATCH', path: `/api/v1/sessions/${id}`, body: { title: CHATS[seeded.key].title } });
    if (seeded.folder === true) {
      await owner.call({ method: 'PUT', path: `/api/v1/sessions/${id}/folder`, body: { folder_id: folder } });
    }
    await backdate({ api, id, daysAgo: seeded.daysAgo });
  }

  const schedules = await owner.call({ method: 'GET', path: '/api/v1/schedules' });
  const list = isRecord(schedules) && Array.isArray(schedules['data']) ? schedules['data'] : [];
  const paused: unknown = list.find(item => isRecord(item) && item['name'] === PAUSED_SCHEDULE);
  if (!isRecord(paused) || typeof paused['id'] !== 'string' || !isRecord(paused['manifest'])) {
    throw new Error(`The schedule ${PAUSED_SCHEDULE} was not made.`);
  }
  // The update takes only the fields a person can change.
  const { task, cron, kind, run_at, timezone } = paused['manifest'];
  await owner.call({
    method: 'PUT',
    path: `/api/v1/schedules/${paused['id']}`,
    body: { name: PAUSED_SCHEDULE, manifest: { task, cron, kind, run_at, timezone, status: 'paused' } },
  });

  // One run each, so the Schedules page has something under Last 5 runs.
  for (const name of RUN_SCHEDULES) {
    const schedule: unknown = list.find(item => isRecord(item) && item['name'] === name);
    if (!isRecord(schedule) || typeof schedule['id'] !== 'string')
      throw new Error(`The schedule ${name} was not made.`);
    await owner.call({ method: 'POST', path: '/api/v1/schedules/runs', body: { schedule_id: schedule['id'] } });
  }
  await removeRunChats(owner);

  const me = await owner.call({ method: 'GET', path: '/api/v1/auth/me' });
  const subject = isRecord(me) && isRecord(me['data']) ? me['data']['subject'] : undefined;
  const ownerId = isRecord(subject) ? subject['id'] : undefined;
  if (typeof ownerId !== 'string') throw new Error('The server did not say who is signed in.');
  const due = new Date(Date.now() - DUE_REMINDER.minutesAgo * 60 * 1000);
  await new DeliveryStore(api.db()).create({
    tenant_id: TENANT_ID,
    created_by: ownerId,
    kind: 'reminder',
    level: 'nudge',
    text: DUE_REMINDER.text,
    reason: `You asked to be reminded on ${formatRunTime({ at: due, timezone: TIME_ZONE })}.`,
    link: null,
    created_at: due,
  });
}
