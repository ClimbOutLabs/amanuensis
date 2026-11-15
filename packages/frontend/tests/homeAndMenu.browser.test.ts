import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer } from 'vite';

import { MODEL_FQN, startApprovalTestServer } from '../../trueforge/tests/fixtures/approvalTestServer.ts';
import { FINAL_TEXT } from '../../trueforge/tests/fixtures/scriptedModelServer.ts';
import { inProcessApi } from './support/approvalChat.ts';
import { withinDeadline } from './support/deadline.ts';
import { featureShotPath, saveFailureShots } from './support/featureShots.ts';
import { findChromiumExecutable } from './support/findChromiumExecutable.ts';
import { FIRST_LOAD_TIMEOUT_MS } from './support/firstLoad.ts';
import { privateViteCache } from './support/viteCache.ts';

const RENDER_TIMEOUT_MS = 45_000;
// Shorter than the test's own limit, so a stuck test ends itself and cleans up.
const DEADLINE_MS = 480_000;
const THEMES = [
  { preset: 'paper', mode: 'light' },
  { preset: 'paper', mode: 'dark' },
  { preset: 'midnight', mode: 'light' },
  { preset: 'midnight', mode: 'dark' },
] as const;

/** Where the home cards end, and anything on home that would need scrolling. */
async function homeFit(page: Page) {
  await page.getByRole('heading', { name: /Some things .* can do/ }).waitFor({ timeout: FIRST_LOAD_TIMEOUT_MS });
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[aria-labelledby="aman-home-cards-heading"] li'));
    const scrollers = Array.from(document.querySelectorAll('*')).filter(el => {
      const style = getComputedStyle(el);
      return /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
    });
    return {
      cards: cards.length,
      titles: cards.map(card => card.querySelector('[data-role="home-card-title"]')?.textContent ?? ''),
      lowest: Math.max(...cards.map(card => card.getBoundingClientRect().bottom)),
      scrollers: scrollers.map(
        el =>
          `${el.getAttribute('data-slot') ?? el.className.toString().slice(0, 60)} (${el.scrollHeight - el.clientHeight}px over)`,
      ),
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
    };
  });
}

function assertFits(fit: Awaited<ReturnType<typeof homeFit>>, label: string): void {
  assert.equal(fit.cards, 4, `${label}: home shows four cards`);
  assert.deepEqual(
    fit.titles,
    ["Everything's in my head", "I can't get started", 'Say it kindly', "What's for dinner this week?"],
    `${label}: a fresh install shows the cards that need nothing connected`,
  );
  assert.ok(fit.lowest <= 900, `${label}: every card is on screen (lowest edge ${fit.lowest}px)`);
  assert.deepEqual(fit.scrollers, [], `${label}: nothing on home needs scrolling`);
  assert.equal(fit.pageScrolls, false, `${label}: the page does not scroll`);
}

function composer(page: Page) {
  return page.locator('[data-slot="aui_composer-input"]').first();
}

/**
 * Signs the page in as a connected account, so the host's Sign out item shows. The real answer is
 * read once up front, because a read made inside the route is lost when the page moves on.
 */
async function asConnectedAccount({ page, origin }: { page: Page; origin: string }): Promise<void> {
  const response = await page.request.get(`${origin}/api/v1/auth/me`);
  const body: unknown = await response.json();
  const data = typeof body === 'object' && body !== null && 'data' in body ? body.data : undefined;
  const patched =
    typeof data === 'object' && data !== null ? { ...body, data: { ...data, type: 'oidc-connected' } } : body;
  await page.route('**/api/v1/auth/me', async route => {
    await route.fulfill({ status: response.status(), json: patched });
  });
}

test(
  'home fits 1440×900, the More menu uses the theme with a label on every item, and new chats offer the agent picker',
  { timeout: 600_000 },
  async () => {
    const api = await startApprovalTestServer();
    const viteCache = privateViteCache('home-and-menu');
    const vite = await createServer({
      cacheDir: viteCache.cacheDir,
      root: fileURLToPath(new URL('../', import.meta.url)),
      logLevel: 'error',
      plugins: [inProcessApi(api)],
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    let browser: Browser | undefined;
    let at = 'starting the app';
    try {
      await withinDeadline({
        ms: DEADLINE_MS,
        where: () => at,
        run: async () => {
          await vite.listen();
          const address = vite.httpServer?.address();
          if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
          const origin = `http://127.0.0.1:${address.port}`;
          browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });

          at = 'the first-run home';
          // The first-run home, with its setup card.
          const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          const freshPage = await fresh.newPage();
          await freshPage.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: FIRST_LOAD_TIMEOUT_MS });
          assertFits(await homeFit(freshPage), 'first run');
          await fresh.close();

          at = 'the first chat';
          // A first chat, so home is the everyday home rather than the first-run tour.
          const first = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          const firstPage = await first.newPage();
          await firstPage.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
          await composer(firstPage).waitFor({ timeout: RENDER_TIMEOUT_MS });
          await composer(firstPage).fill('Plan my week');
          await composer(firstPage).press('Enter');
          await firstPage.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
          await first.close();

          at = 'home after a first chat';
          const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          const page = await context.newPage();
          await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
          assertFits(await homeFit(page), 'after a first chat');
          await page.screenshot({
            path: await featureShotPath({ surface: 'screen:home', step: 'after-a-first-chat' }),
          });
          await context.close();

          for (const theme of THEMES) {
            at = `the More menu in ${theme.preset} ${theme.mode}`;
            const themed = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            await themed.addInitScript(({ preset, mode }) => {
              localStorage.setItem('aui-theme-preset', preset);
              localStorage.setItem('aui-theme-preference', mode);
            }, theme);
            const menuPage = await themed.newPage();
            await asConnectedAccount({ page: menuPage, origin });
            await menuPage.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
            await menuPage.getByRole('button', { name: 'More', exact: true }).click({ timeout: RENDER_TIMEOUT_MS });
            const menu = menuPage.getByRole('menu');
            await menu.getByRole('button', { name: 'Sign out', exact: true }).waitFor({ timeout: RENDER_TIMEOUT_MS });
            const label = `${theme.preset} ${theme.mode}`;
            await menuPage.screenshot({
              path: await featureShotPath({ surface: 'screen:home', step: `more-menu-${theme.preset}-${theme.mode}` }),
            });

            const look = await menu.evaluate(el => {
              const root = el.closest('.aui-theme-root');
              if (root === null) throw new Error('the menu is outside the theme');
              const probe = document.createElement('div');
              probe.style.background = 'var(--card-bg)';
              probe.style.borderColor = 'var(--border)';
              root.append(probe);
              const tokens = {
                surface: getComputedStyle(probe).backgroundColor,
                border: getComputedStyle(probe).borderColor,
              };
              probe.remove();
              const style = getComputedStyle(el);
              const rows = Array.from(el.querySelectorAll('button')).map(row => {
                const rowStyle = getComputedStyle(row);
                const icon = row.querySelector('svg');
                return {
                  text: (row.textContent ?? '').trim(),
                  visible: row.getBoundingClientRect().width > 0 && rowStyle.visibility !== 'hidden',
                  height: Math.round(row.getBoundingClientRect().height),
                  size: rowStyle.fontSize,
                  family: rowStyle.fontFamily,
                  color: rowStyle.color,
                  icon: icon === null ? null : Math.round(icon.getBoundingClientRect().width),
                };
              });
              return { surface: style.backgroundColor, border: style.borderTopColor, tokens, rows };
            });

            assert.equal(look.surface, look.tokens.surface, `${label}: the menu uses the theme's surface`);
            assert.equal(look.border, look.tokens.border, `${label}: the menu uses the theme's border`);
            for (const row of look.rows) {
              assert.ok(
                row.visible && row.text !== '',
                `${label}: every item has a visible label (${JSON.stringify(row)})`,
              );
            }
            const labels = look.rows.map(row => row.text);
            for (const expected of ['Settings', 'Sign out']) {
              assert.ok(labels.includes(expected), `${label}: the menu lists ${expected} (${labels.join(', ')})`);
            }
            assert.equal(
              new Set(look.rows.map(row => row.height)).size,
              1,
              `${label}: one row height (${JSON.stringify(look.rows)})`,
            );
            assert.equal(
              new Set(look.rows.map(row => row.size)).size,
              1,
              `${label}: one text size (${JSON.stringify(look.rows)})`,
            );
            assert.equal(new Set(look.rows.map(row => row.family)).size, 1, `${label}: one font`);
            assert.equal(new Set(look.rows.map(row => row.color)).size, 1, `${label}: one text colour`);
            const icons = look.rows.flatMap(row => (row.icon === null ? [] : [row.icon]));
            assert.equal(new Set(icons).size, 1, `${label}: one icon size (${icons.join(', ')})`);
            await themed.close();
          }

          at = 'Sign out in the More menu';
          // Sign out in the menu asks first, and the question outlives the menu that closes behind it.
          const signOutContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          const signOutPage = await signOutContext.newPage();
          await asConnectedAccount({ page: signOutPage, origin });
          let signOutRequests = 0;
          await signOutPage.route('**/api/v1/auth/logout', async route => {
            signOutRequests += 1;
            await route.fulfill({ status: 204 });
          });
          await signOutPage.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
          const more = signOutPage.getByRole('button', { name: 'More', exact: true });
          const signOutRow = signOutPage.getByRole('menu').getByRole('button', { name: 'Sign out', exact: true });
          const question = signOutPage.getByRole('dialog', { name: 'Sign out?' });
          await more.click({ timeout: RENDER_TIMEOUT_MS });
          await signOutRow.click({ timeout: RENDER_TIMEOUT_MS });
          await question.getByRole('button', { name: 'Stay' }).click({ timeout: RENDER_TIMEOUT_MS });
          await question.waitFor({ state: 'hidden', timeout: RENDER_TIMEOUT_MS });
          assert.equal(signOutRequests, 0, 'Stay signs nobody out');
          assert.equal(
            await more.evaluate(el => el === document.activeElement),
            true,
            'after Stay, the keyboard is back on More',
          );
          await more.click({ timeout: RENDER_TIMEOUT_MS });
          await signOutRow.click({ timeout: RENDER_TIMEOUT_MS });
          const leaves = signOutPage.waitForRequest(request => request.isNavigationRequest(), {
            timeout: RENDER_TIMEOUT_MS,
          });
          await question.getByRole('button', { name: 'Sign out' }).click({ timeout: RENDER_TIMEOUT_MS });
          await leaves;
          assert.equal(signOutRequests, 1, 'Sign out asks the server once');
          await signOutContext.close();

          at = 'picking an agent on a new chat';
          // Once an agent exists, the picker is on every new chat, and a pick there answers the first message.
          const created = await api.request('/api/v1/personas', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              persona: { display_name: 'Nova', aliases: [], instructions: 'Answer briefly.', model_name: MODEL_FQN },
            }),
          });
          assert.ok(created.ok, `the agent was created (${String(created.status)})`);
          const pickContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          const pickPage = await pickContext.newPage();
          await pickPage.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
          const picker = pickPage.getByTitle('Choose a persona');
          await picker.waitFor({ timeout: RENDER_TIMEOUT_MS });
          await picker.click();
          await pickPage.getByRole('menuitem', { name: 'Nova' }).click();
          await pickPage.getByTestId('active-persona').getByText('Nova').waitFor({ timeout: RENDER_TIMEOUT_MS });
          await composer(pickPage).fill('Hello there');
          await composer(pickPage).press('Enter');
          await pickPage.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
          await pickPage.waitForURL(/\/sessions\//, { timeout: RENDER_TIMEOUT_MS });
          const sessionId = /\/sessions\/([^/?#]+)/.exec(pickPage.url())?.[1];
          assert.ok(sessionId !== undefined, 'the first message made a chat');
          const answered: unknown = await (await api.request(`/api/v1/sessions/${sessionId}/persona`)).json();
          assert.match(
            JSON.stringify(answered),
            /"persona_name":"Nova"/,
            'the picked agent answered the first message',
          );

          at = 'starting another new chat';
          // Starting another new chat offers the picker again.
          const chatList = pickPage.getByRole('complementary', { name: 'Recent chats' });
          if (!(await chatList.isVisible())) {
            await pickPage.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: 'Chats' }).click();
          }
          // A chat with no title yet is listed as New Chat, so the button is matched by its exact name.
          await chatList.getByRole('button', { name: 'New chat', exact: true }).click();
          await pickPage.getByTitle('Choose a persona').waitFor({ timeout: RENDER_TIMEOUT_MS });
          await pickContext.close();

          at = 'the chat header at 360px';
          // At 360px wide the chat header keeps Chat actions on screen: the light and dark button
          // steps aside below the md breakpoint, and the Appearance page keeps the full pick.
          const phoneContext = await browser.newContext({ viewport: { width: 360, height: 800 } });
          const phonePage = await phoneContext.newPage();
          await phonePage.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
          await composer(phonePage).waitFor({ timeout: RENDER_TIMEOUT_MS });
          await composer(phonePage).fill('A note from a narrow phone');
          await composer(phonePage).press('Enter');
          await phonePage.locator('main').getByText(FINAL_TEXT).first().waitFor({ timeout: RENDER_TIMEOUT_MS });
          const chatActions = phonePage.getByRole('button', { name: 'Chat actions' });
          await chatActions.waitFor({ timeout: RENDER_TIMEOUT_MS });
          const chatActionsBox = await chatActions.boundingBox();
          assert.ok(chatActionsBox !== null, 'at 360px, Chat actions has a box');
          assert.ok(
            chatActionsBox.x >= 0 && chatActionsBox.x + chatActionsBox.width <= 360,
            `at 360px, Chat actions stays on screen (${chatActionsBox.x} to ${chatActionsBox.x + chatActionsBox.width})`,
          );
          assert.equal(
            await phonePage.getByRole('button', { name: 'Switch to dark' }).isVisible(),
            false,
            'at 360px, the light and dark button steps aside',
          );
          await phoneContext.close();
        },
      });
    } catch (error) {
      await saveFailureShots({ browser, surface: 'screen:home' });
      throw error;
    } finally {
      await browser?.close();
      await vite.close();
      viteCache.remove();
      await api.close();
    }
  },
);
