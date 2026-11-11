/**
 * One person's first hour on the built app, as an installed Aman runs: sign in through the real
 * sign-in service, land on first run, add a model in Settings, chat, come back, and sign out.
 * Needs `pnpm build` first. Nothing here reaches an outside host.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chromium, type Browser, type Page } from 'playwright-core';

import { LOGIN_USER_EMAIL, LOGIN_USER_PASSWORD } from '../../../../scripts/login-service-config.mjs';
import { FINAL_TEXT, startScriptedModelServer } from '../../../trueforge/tests/fixtures/scriptedModelServer.ts';
import { featureShotPath, saveFailureShots } from '../support/featureShots.ts';
import { findChromiumExecutable } from '../support/findChromiumExecutable.ts';
import { startBuiltApp } from './support/builtApp.ts';

const STEP_TIMEOUT_MS = 30_000;
const PROVIDER_NAME = 'scripted';
const MODEL_ID = 'scripted-model';
const MESSAGE = 'Hello from the signed-in journey';

async function shot({ page, surface, step }: { page: Page; surface: string; step: string }): Promise<void> {
  await page.screenshot({ path: await featureShotPath({ surface, step }) });
}

function signInButton(page: Page) {
  return page.getByRole('button', { name: 'Sign in' });
}

test('a person signs in on the built app, adds a model, chats and signs out', { timeout: 300_000 }, async () => {
  const model = await startScriptedModelServer();
  let app: Awaited<ReturnType<typeof startBuiltApp>> | undefined;
  let browser: Browser | undefined;
  try {
    app = await startBuiltApp();
    browser = await chromium.launch({ executablePath: findChromiumExecutable(chromium.executablePath()) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(STEP_TIMEOUT_MS);

    // Signed out: the app shows only the way in, and its API refuses.
    await page.goto(app.origin);
    await signInButton(page).waitFor();
    assert.equal((await page.request.get(`${app.origin}/api/v1/auth/me`)).status(), 401, 'signed out, the API refuses');
    await shot({ page, surface: 'route:auth', step: 'signed-out' });

    // The sign-in service's own page, then back into the app.
    await signInButton(page).click();
    await page.locator('#login').fill(LOGIN_USER_EMAIL);
    await page.locator('#password').fill(LOGIN_USER_PASSWORD);
    await shot({ page, surface: 'route:auth', step: 'sign-in-page' });
    await page.locator('#submit-login').click();

    // First run with no model: the app opens Settings on Models.
    await page.waitForURL(`${app.origin}/settings`);
    const addProvider = page.getByRole('button', { name: 'Add custom provider' });
    await addProvider.waitFor();
    assert.equal(await page.getByText('CONFIGURED', { exact: true }).count(), 0, 'a fresh install has no model yet');
    await shot({ page, surface: 'settings:models', step: 'first-run-no-model' });

    await addProvider.click();
    const form = page.getByRole('dialog');
    await form.locator('#custom-provider-name').fill(PROVIDER_NAME);
    await form.locator('#custom-provider-base-url').fill(model.baseUrl);
    await form.locator('#custom-provider-api-key').fill('scripted-key');
    await form.locator('#custom-provider-model-0-id').fill(MODEL_ID);
    await form.locator('#custom-provider-model-0-context-length').fill('128000');
    await form.locator('#custom-provider-model-0-max-output-tokens').fill('4096');
    await shot({ page, surface: 'route:modelProvider', step: 'custom-provider-form' });
    await form.getByRole('button', { name: 'Add provider' }).click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await shot({ page, surface: 'settings:models', step: 'model-added' });

    // Home now offers the model, and the first-run guide counts it.
    await page.goto(app.origin);
    await page.getByText(`${PROVIDER_NAME}/${MODEL_ID}`).first().waitFor();
    await shot({ page, surface: 'screen:first-run', step: 'built-app-model-added' });

    // A chat reaches the model and its answer comes back.
    await page.getByRole('textbox', { name: 'Message input' }).fill(MESSAGE);
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByText(FINAL_TEXT).first().waitFor();
    await page.waitForURL(/\/sessions\/[a-z0-9]+$/);
    assert.ok(
      model.requests().some(request => JSON.stringify(request).includes(MESSAGE)),
      'the model was sent the message',
    );
    await shot({ page, surface: 'route:turn', step: 'built-app-first-reply' });

    // Coming back later: still signed in, and the chat was kept.
    await page.reload();
    await page.getByText(FINAL_TEXT).first().waitFor();
    await page.getByText(MESSAGE).first().waitFor();
    await shot({ page, surface: 'route:session', step: 'built-app-chat-kept' });

    // Signing out ends it: the way in shows again and the API refuses.
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('dialog', { name: 'Sign out?' }).getByRole('button', { name: 'Sign out' }).click();
    await signInButton(page).waitFor();
    assert.equal((await page.request.get(`${app.origin}/api/v1/auth/me`)).status(), 401, 'signed out, the API refuses');
    await page.goto(`${app.origin}/settings`);
    await signInButton(page).waitFor();
    await shot({ page, surface: 'route:auth', step: 'signed-out-again' });
  } catch (error) {
    await saveFailureShots({ browser, surface: 'screen:signed-in-journey' });
    throw error;
  } finally {
    await browser?.close();
    await app?.close();
    await model.close();
  }
});
