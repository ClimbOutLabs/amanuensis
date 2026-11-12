import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

import { startApprovalTestServer, type ApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import {
  FINAL_TEXT,
  SCRIPTED_DRAFT,
  SCRIPTED_EVENT,
  SCRIPTED_PERSONA,
  SCRIPTED_SCHEDULE,
  SCRIPTED_SKILL,
} from '../../trueforge/tests/fixtures/scriptedModelServer.ts';
import { inProcessApi, pausedSession } from './support/approvalChat.ts';
import { featureShotPath, saveFailureShots } from './support/featureShots.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { FIRST_LOAD_TIMEOUT_MS } from './support/firstLoad.ts';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;

function composer(page: Page) {
  return page.locator('[data-slot="aui_composer-input"]').first();
}

/** Asks for the action in a new chat from home, and waits for the card that asks first. */
async function askFromHome({ page, origin, ask }: { page: Page; origin: string; ask: string }): Promise<void> {
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: FIRST_LOAD_TIMEOUT_MS });
  await composer(page).waitFor({ timeout: FIRST_LOAD_TIMEOUT_MS });
  await composer(page).fill(ask);
  await composer(page).press('Enter');
  await page.getByText('Waiting for you').first().waitFor({ timeout: RENDER_TIMEOUT_MS });
}

/** Presses Allow on the one waiting card and waits for the turn to finish. */
async function allow(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'Allow', exact: true });
  // The "Waiting for you" line can show before the card's buttons do.
  await button.first().waitFor({ timeout: RENDER_TIMEOUT_MS });
  assert.equal(await button.count(), 1, 'one card is waiting');
  await button.click();
  await page.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
  await button.waitFor({ state: 'detached', timeout: RENDER_TIMEOUT_MS });
}

async function savedNames({ api, path }: { api: ApprovalTestServer; path: string }): Promise<string> {
  const response = await api.request(path);
  assert.equal(response.status, 200, `${path} answers`);
  return response.text();
}

async function savedDraftIds(api: ApprovalTestServer): Promise<string[]> {
  return (await api.evalSources().gmail.listDrafts({ maxResults: 10, pageToken: undefined })).draftIds;
}

/** How many events on the scripted day carry the scripted title. */
async function savedEventCount(api: ApprovalTestServer): Promise<number> {
  const day = SCRIPTED_EVENT.start.slice(0, 10);
  const found = await api.evalSources().calendar.listEvents({
    timeMin: `${day}T00:00:00`,
    timeMax: `${day}T23:59:59`,
    query: SCRIPTED_EVENT.title,
    maxResults: 10,
    pageToken: undefined,
    timeZone: SCRIPTED_EVENT.time_zone,
  });
  return found.events.length;
}

test('each kind of approval card shows what will happen, and Allow does it', { timeout: 600_000 }, async () => {
  const api = await startApprovalTestServer();
  const viteCache = privateViteCache('approval-kinds');
  const vite = await createServer({
    cacheDir: viteCache.cacheDir,
    root: fileURLToPath(new URL('../', import.meta.url)),
    logLevel: 'error',
    plugins: [inProcessApi(api)],
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  let browser: Browser | undefined;
  let current = 'approval:plain';
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    // The plain card: a connector's write tool, which carries no message, event, schedule or persona.
    const paused = await pausedSession(api);
    await page.goto(`${origin}/sessions/${paused.sessionId}`, {
      waitUntil: 'domcontentloaded',
      timeout: FIRST_LOAD_TIMEOUT_MS,
    });
    await page.getByText('Waiting for you').first().waitFor({ timeout: FIRST_LOAD_TIMEOUT_MS });
    await page.screenshot({ path: await featureShotPath({ surface: current, step: '1-card' }) });
    await allow(page);
    await page.screenshot({ path: await featureShotPath({ surface: current, step: '2-allowed' }) });

    current = 'approval:persona';
    assert.ok(
      !(await savedNames({ api, path: '/api/v1/personas' })).includes(SCRIPTED_PERSONA.name),
      'the persona does not exist before the card is allowed',
    );
    await askFromHome({ page, origin, ask: 'run:create_persona please' });
    const personaCard = page.locator('main');
    await personaCard.getByText(`Add the persona "${SCRIPTED_PERSONA.name}"?`).waitFor({ timeout: RENDER_TIMEOUT_MS });
    await personaCard.getByText(SCRIPTED_PERSONA.description).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.screenshot({ path: await featureShotPath({ surface: current, step: '1-card' }) });
    assert.ok(
      !(await savedNames({ api, path: '/api/v1/personas' })).includes(SCRIPTED_PERSONA.name),
      'nothing is saved while the card waits',
    );
    await allow(page);
    assert.ok(
      (await savedNames({ api, path: '/api/v1/personas' })).includes(SCRIPTED_PERSONA.name),
      'Allow saved the persona',
    );
    await page.screenshot({ path: await featureShotPath({ surface: current, step: '2-allowed' }) });

    current = 'approval:schedule';
    await askFromHome({ page, origin, ask: 'run:create_schedule please' });
    await page.locator('main').getByText(SCRIPTED_SCHEDULE.task).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page
      .locator('main')
      .getByText(`Every Friday at 4:00 PM (${SCRIPTED_SCHEDULE.time_zone})`)
      .waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.screenshot({ path: await featureShotPath({ surface: current, step: '1-card' }) });
    assert.ok(
      !(await savedNames({ api, path: '/api/v1/schedules' })).includes(SCRIPTED_SCHEDULE.name),
      'nothing is saved while the card waits',
    );
    await allow(page);
    assert.ok(
      (await savedNames({ api, path: '/api/v1/schedules' })).includes(SCRIPTED_SCHEDULE.name),
      'Allow saved the schedule',
    );
    await page.screenshot({ path: await featureShotPath({ surface: current, step: '2-allowed' }) });

    // A starter skill: it is added as shipped, so the card needs nothing from outside this machine.
    current = 'approval:skill';
    assert.ok(
      !(await savedNames({ api, path: '/api/v1/settings/skills' })).includes(SCRIPTED_SKILL.name),
      'the skill is not there before the card is allowed',
    );
    await askFromHome({ page, origin, ask: 'run:install_skill please' });
    const skillCard = page.locator('main');
    await skillCard.getByText(`Add the skill "${SCRIPTED_SKILL.name}"?`).waitFor({ timeout: RENDER_TIMEOUT_MS });
    await skillCard
      .getByText(`github.com/anthropics/skills, folder ${SCRIPTED_SKILL.path}`)
      .first()
      .waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.screenshot({ path: await featureShotPath({ surface: current, step: '1-card' }) });
    assert.ok(
      !(await savedNames({ api, path: '/api/v1/settings/skills' })).includes(SCRIPTED_SKILL.name),
      'nothing is saved while the card waits',
    );
    await allow(page);
    assert.ok(
      (await savedNames({ api, path: '/api/v1/settings/skills' })).includes(SCRIPTED_SKILL.name),
      'Allow added the skill',
    );
    await page.screenshot({ path: await featureShotPath({ surface: current, step: '2-allowed' }) });

    // Gmail and Google Calendar are the invented inbox and calendar from here on, so nothing reaches Google.
    api.setEvalMode(true);

    current = 'approval:email';
    assert.deepEqual(await savedDraftIds(api), [], 'the inbox starts with no drafts');
    await askFromHome({ page, origin, ask: 'run:draft_email please' });
    const mailCard = page.locator('main');
    await mailCard.getByText('Save this draft?').first().waitFor({ timeout: RENDER_TIMEOUT_MS });
    for (const shown of [SCRIPTED_DRAFT.to[0], SCRIPTED_DRAFT.subject, SCRIPTED_DRAFT.body]) {
      await mailCard.getByText(shown).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
    }
    await page.screenshot({ path: await featureShotPath({ surface: current, step: '1-card' }) });
    assert.deepEqual(await savedDraftIds(api), [], 'nothing is saved while the card waits');
    await allow(page);
    const [draftId, ...otherDrafts] = await savedDraftIds(api);
    assert.ok(draftId !== undefined && otherDrafts.length === 0, 'Allow saved one draft');
    const draft = await api.evalSources().gmail.getDraft(draftId);
    const subject = draft.message?.payload?.headers?.find(header => header.name.toLowerCase() === 'subject');
    assert.equal(subject?.value, SCRIPTED_DRAFT.subject, 'the saved draft is the one the card showed');
    await page.screenshot({ path: await featureShotPath({ surface: current, step: '2-allowed' }) });

    current = 'approval:calendar_event';
    assert.equal(await savedEventCount(api), 0, 'the event is not in the calendar before the card is allowed');
    await askFromHome({ page, origin, ask: 'run:create_event please' });
    const eventCard = page.locator('main');
    await eventCard
      .getByText(`Add "${SCRIPTED_EVENT.title}" to your calendar?`)
      .first()
      .waitFor({ timeout: RENDER_TIMEOUT_MS });
    await eventCard.getByText(SCRIPTED_EVENT.location).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
    await page.screenshot({ path: await featureShotPath({ surface: current, step: '1-card' }) });
    assert.equal(await savedEventCount(api), 0, 'nothing is saved while the card waits');
    await allow(page);
    assert.equal(await savedEventCount(api), 1, 'Allow added the event');
    await page.screenshot({ path: await featureShotPath({ surface: current, step: '2-allowed' }) });
  } catch (error) {
    await saveFailureShots({ browser, surface: current });
    throw error;
  } finally {
    await browser?.close();
    await vite.close();
    viteCache.remove();
    await api.close();
  }
});
