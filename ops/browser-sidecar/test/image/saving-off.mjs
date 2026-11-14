// Run inside the built image: fails unless Chromium's password, card and address saving are off by policy.
// The image's Chromium differs by architecture (Chrome for Testing on x64, Playwright's own build on arm64),
// and each reads its policy from a different folder, so this is checked on the image itself.
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = createRequire('/app/package.json')('playwright-core');
const PREFS = [['credentials_enable_service'], ['autofill', 'credit_card_enabled'], ['autofill', 'profile_enabled']];

const dir = await mkdtemp(path.join(tmpdir(), 'saving-off-'));
const context = await chromium.launchPersistentContext(dir, { headless: false, chromiumSandbox: false });
let failed = false;
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('chrome://prefs-internals');
  const prefs = JSON.parse(await page.innerText('body'));
  for (const keys of PREFS) {
    const pref = keys.reduce((value, key) => value?.[key], prefs);
    const managedOff = pref?.value === false && Array.isArray(pref.metadata) && pref.metadata.includes('managed');
    console.log(`${keys.join('.')}: ${managedOff ? 'off by policy' : `NOT off by policy (${JSON.stringify(pref)})`}`);
    failed ||= !managedOff;
  }
} finally {
  await context.close();
  await rm(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
