import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

import {
  CARDS,
  HOME_TOPIC_IDS,
  HOME_TOPICS,
  homeCardsFor,
  type CardKey,
  type HomeTopicId,
  type TourCapabilities,
  type TourCard,
} from '../../trueforge-ui/src/components/tourPrompts.ts';
import { startApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { FINAL_TEXT } from '../../trueforge/tests/fixtures/scriptedModelServer.ts';
import { inProcessApi } from './support/approvalChat.ts';
import { withinDeadline } from './support/deadline.ts';
import { featureShotPath, saveFailureShots } from './support/featureShots.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { FIRST_LOAD_TIMEOUT_MS } from './support/firstLoad.ts';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;
// Shorter than the test's own limit, so a stuck test ends itself and cleans up.
const DEADLINE_MS = 780_000;

/** The two homes a person can have: nothing connected, and Google mail and calendar connected. */
const HOMES: readonly { name: string; google: boolean; capabilities: TourCapabilities }[] = [
  {
    name: 'nothing connected',
    google: false,
    capabilities: { email: false, calendar: false, sandbox: false, maps: true },
  },
  { name: 'Google connected', google: true, capabilities: { email: true, calendar: true, sandbox: false, maps: true } },
];

/** The pills this test chooses, by the name their screenshots are filed under. */
const PILLS_CHOSEN: readonly string[] = [
  'pill:behind',
  'pill:coming_up',
  'pill:help_me_think',
  'pill:just_moved',
  'pill:money',
  'pill:someone_i_look_after',
  'pill:write_hard',
];

/**
 * The cards this test presses. A pill lists up to six cards and the home shows the first four that
 * work here, so a card behind four that always work is on no home, and is not in this list.
 */
const CARDS_PRESSED: readonly string[] = [
  'tour:ask_for',
  'tour:bill',
  'tour:brief',
  'tour:budget',
  'tour:care',
  'tour:chores',
  'tour:decide',
  'tour:dinner',
  'tour:doctor',
  'tour:dropping',
  'tour:follow_up',
  'tour:forms',
  'tour:fresh',
  'tour:gathering',
  'tour:hard_talk',
  'tour:head',
  'tour:kindly',
  'tour:language',
  'tour:letter',
  'tour:meds',
  'tour:money_due',
  'tour:next_meeting',
  'tour:overcharged',
  'tour:places',
  'tour:remember',
  'tour:say_no',
  'tour:school',
  'tour:sort_out',
  'tour:start',
  'tour:subscriptions',
  'tour:talk',
  'tour:their_appointment',
  'tour:thread',
  'tour:today',
  'tour:trip',
  'tour:waiting',
  'tour:week',
];

function isCardKey(value: string): value is CardKey {
  return Object.hasOwn(CARDS, value);
}

const CARD_KEYS = Object.keys(CARDS).filter(isCardKey);

function keyOf(card: TourCard): CardKey {
  const key = CARD_KEYS.find(candidate => CARDS[candidate] === card);
  if (key === undefined) throw new Error(`"${card.title}" is not one of the home cards`);
  return key;
}

/**
 * Answers the Google status read as an account with mail and calendar granted; nothing leaves this machine.
 * The real answer is read once up front, because a read made inside the route is lost when the page reloads.
 */
async function asGoogleConnected({ page, origin }: { page: Page; origin: string }): Promise<void> {
  const response = await page.request.get(`${origin}/api/v1/user/settings/google/status`);
  const body: unknown = await response.json();
  const data = typeof body === 'object' && body !== null && 'data' in body ? body.data : undefined;
  if (typeof data !== 'object' || data === null || !('features' in data) || !Array.isArray(data.features)) {
    throw new Error('the Google status answer has no list of features');
  }
  const features: unknown[] = data.features;
  const connected = {
    ...body,
    data: {
      ...data,
      state: 'connected',
      features: features.map(item => (typeof item === 'object' && item !== null ? { ...item, granted: true } : item)),
    },
  };
  await page.route('**/api/v1/user/settings/google/status', async route => {
    await route.fulfill({ json: connected });
  });
}

function cardList(page: Page) {
  return page.locator('[aria-labelledby="aman-home-cards-heading"] li');
}

/** Opens home with the pill chosen (or none), and waits for the cards that pill should show. */
async function openHome({
  page,
  origin,
  topic,
  titles,
}: {
  page: Page;
  origin: string;
  topic: HomeTopicId | null;
  titles: readonly string[];
}): Promise<void> {
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: FIRST_LOAD_TIMEOUT_MS });
  const pills = page.getByRole('list', { name: 'What would help you most?' });
  await pills.waitFor({ state: 'visible', timeout: FIRST_LOAD_TIMEOUT_MS });
  const pressed = pills.locator('button[aria-pressed="true"]');
  if (topic === null) {
    if ((await pressed.count()) > 0) await pressed.first().click();
  } else {
    const pill = pills.getByRole('button', { name: HOME_TOPICS[topic].label, exact: true });
    if ((await pill.getAttribute('aria-pressed')) !== 'true') await pill.click();
    assert.equal(
      await pill.getAttribute('aria-pressed'),
      'true',
      `the "${HOME_TOPICS[topic].label}" pill shows as chosen`,
    );
    assert.equal(await pressed.count(), 1, 'one pill is chosen at a time');
  }
  await page.waitForFunction(
    expected => {
      const shown = Array.from(
        document.querySelectorAll('[aria-labelledby="aman-home-cards-heading"] [data-role="home-card-title"]'),
      ).map(el => el.textContent);
      return shown.length === expected.length && shown.every((title, index) => title === expected[index]);
    },
    [...titles],
    { timeout: RENDER_TIMEOUT_MS },
  );
}

test(
  'every pill shows its cards, and pressing a card sends that card’s words as the first message of a chat',
  { timeout: 900_000 },
  async () => {
    const api = await startApprovalTestServer();
    const viteCache = privateViteCache('home-cards');
    const vite = await createServer({
      cacheDir: viteCache.cacheDir,
      root: fileURLToPath(new URL('../', import.meta.url)),
      logLevel: 'error',
      plugins: [inProcessApi(api)],
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    let browser: Browser | undefined;
    let current = 'screen:home';
    const pressedCards = new Set<CardKey>();
    try {
      await withinDeadline({
        ms: DEADLINE_MS,
        where: () => current,
        run: async () => {
          await vite.listen();
          const address = vite.httpServer?.address();
          if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
          const origin = `http://127.0.0.1:${address.port}`;
          browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });

          for (const home of HOMES) {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const page = await context.newPage();
            if (home.google) await asGoogleConnected({ page, origin });
            const shotStep = home.google ? 'cards-with-google' : 'cards';

            for (const topic of [null, ...HOME_TOPIC_IDS]) {
              const cards = homeCardsFor({ topic, capabilities: home.capabilities });
              const titles = cards.map(card => card.title);
              current = topic === null ? 'screen:home' : `pill:${topic}`;
              await openHome({ page, origin, topic, titles });
              await page.screenshot({
                path: await featureShotPath({
                  surface: current,
                  step: topic === null ? `no-pill-${shotStep}` : shotStep,
                }),
              });

              if (topic !== null) {
                // The chosen pill is still chosen after the app loads again.
                await page.reload({ waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
                await page
                  .getByRole('button', { name: HOME_TOPICS[topic].label, exact: true })
                  .and(page.locator('[aria-pressed="true"]'))
                  .waitFor({ timeout: RENDER_TIMEOUT_MS });
              }

              for (const card of cards) {
                const key = keyOf(card);
                if (pressedCards.has(key)) continue;
                current = `tour:${key}`;
                await openHome({ page, origin, topic, titles });
                // The brief chat does not show its opening message, so the check is what the app sends.
                const sent = page.waitForRequest(
                  request =>
                    request.method() === 'POST' && (request.postData() ?? '').includes(JSON.stringify(card.prompt)),
                  { timeout: RENDER_TIMEOUT_MS },
                );
                await cardList(page).getByRole('button', { name: card.title }).click();
                await sent;
                await page.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
                await page.screenshot({
                  path: await featureShotPath({ surface: current, step: 'sent-as-first-message' }),
                });
                pressedCards.add(key);
              }
            }
            await context.close();
          }

          assert.deepEqual(
            HOME_TOPIC_IDS.map(id => `pill:${id}`).sort(),
            [...PILLS_CHOSEN],
            'every pill the home has was chosen',
          );
          assert.deepEqual(
            [...pressedCards].map(key => `tour:${key}`).sort(),
            [...CARDS_PRESSED],
            'the cards a home can show are the cards this test lists; update CARDS_PRESSED and tests/nightly-coverage.json together',
          );
        },
      });
    } catch (error) {
      await saveFailureShots({ browser, surface: current });
      throw error;
    } finally {
      await browser?.close();
      await vite.close();
      viteCache.remove();
      await api.close();
    }
  },
);
