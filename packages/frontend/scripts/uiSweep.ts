/**
 * Opens every screen of the app with the demo world, at a computer size, a phone size, a small phone size and in
 * dark colours, and writes down what looks wrong: errors, parts that do not fit, controls with no name. It saves
 * a picture of each screen and a report beside them, for a person to look through. This is a tool, not a test:
 * run it with `pnpm ui:sweep`, or `pnpm ui:sweep chat spaces` for just those screens.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright-core';

import { DESKTOP, PHONE, startDemoApp, type DemoApp, type ScreenSize } from './docsScreenshots/demoApp.ts';
import { TEST_WORDS } from './docsScreenshots/demoWorld.ts';
import { open, pickTab, settingsTab, settle, STEP_TIMEOUT_MS } from './docsScreenshots/steps.ts';
import { measure } from './uiSweep/checks.ts';
import { SURFACES, type Surface } from './uiSweep/surfaces.ts';

const SIZES: readonly ScreenSize[] = [
  { ...DESKTOP, scale: 1 },
  { ...PHONE, scale: 1 },
  { label: 'small-phone', viewport: { width: 320, height: 640 }, phone: true, scale: 1 },
  { ...PHONE, label: 'phone-dark', dark: true, scale: 1 },
];

interface Finding {
  surface: string;
  size: string;
  problems: string[];
  picture: string;
}

function slug(words: string): string {
  return words
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function tabNames(page: Page, selector: string): Promise<string[]> {
  const names = await page.locator(selector).allInnerTexts();
  return names.map(name => name.trim()).filter(name => name !== '');
}

/** One screen for each Settings tab, and one more for each tab inside it, as the app lists them today. */
async function settingsSurfaces(app: DemoApp): Promise<Surface[]> {
  const context = await app.newContext({ ...DESKTOP, scale: 1 });
  const page = await context.newPage();
  const step = { page, origin: app.origin, phone: false, api: app.api, owner: app.owner };
  const found: Surface[] = [];
  try {
    await open('/settings')(step);
    const strip = '[role="tablist"][aria-label="Settings sections"] [role="tab"]';
    await page.locator(strip).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    for (const tab of await tabNames(page, strip)) {
      found.push({ name: `settings-${slug(tab)}`, steps: [settingsTab(tab)] });
      await settingsTab(tab)(step);
      await settle(page);
      for (const inner of await tabNames(page, '[role="tabpanel"] [role="tab"]')) {
        found.push({ name: `settings-${slug(tab)}-${slug(inner)}`, steps: [settingsTab(tab), pickTab(inner)] });
      }
    }
  } finally {
    await context.close();
  }
  return found;
}

async function look({
  app,
  surface,
  size,
  outDir,
}: {
  app: DemoApp;
  surface: Surface;
  size: ScreenSize;
  outDir: string;
}): Promise<Finding> {
  const context = await app.newContext(size);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(`The page threw an error: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error')
      problems.push(`The browser console shows an error: ${message.text().slice(0, 200)}`);
  });
  page.on('response', response => {
    if (response.status() >= 400 && response.url().includes('/api/')) {
      problems.push(
        `${String(response.status())} from ${response.request().method()} ${new URL(response.url()).pathname}`,
      );
    }
  });
  const picture = join(outDir, `${surface.name}-${size.label}.png`);
  try {
    for (const step of surface.steps) {
      await step({ page, origin: app.origin, phone: size.phone, api: app.api, owner: app.owner });
    }
    await settle(page);
    const shown = await page.locator('body').innerText();
    const testWords = TEST_WORDS.filter(word => shown.includes(word));
    if (testWords.length > 0) problems.push(`The screen shows test text (${testWords.join(', ')}).`);
    problems.push(...(await measure({ page, phone: size.phone })));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push(`The screen could not be reached: ${message.split('\n')[0] ?? message}`);
  }
  await page.screenshot({ path: picture, animations: 'disabled', caret: 'hide' }).catch(() => undefined);
  await context.close();
  return { surface: surface.name, size: size.label, problems: [...new Set(problems)], picture };
}

function report(findings: readonly Finding[]): string {
  const lines = ['# What the look-over found', ''];
  const withProblems = findings.filter(finding => finding.problems.length > 0);
  lines.push(
    `${String(findings.length)} screens were opened. ${String(withProblems.length)} have something to look at.`,
    '',
  );
  for (const finding of withProblems) {
    lines.push(`## ${finding.surface} (${finding.size})`, '', `Picture: ${finding.picture}`, '');
    lines.push(...finding.problems.map(problem => `- ${problem}`), '');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const outDir = await mkdtemp(join(tmpdir(), 'aman-ui-sweep-'));
  await mkdir(outDir, { recursive: true });
  const app = await startDemoApp('ui-sweep');
  const findings: Finding[] = [];
  try {
    await app.addModel();
    console.log('Setting up the demo world...');
    await app.addEverything();
    const every = [...(await settingsSurfaces(app)), ...SURFACES];
    const unknown = wanted.filter(name => !every.some(surface => surface.name === name));
    if (unknown.length > 0) {
      throw new Error(
        `There is no screen named ${unknown.join(', ')}. Pick from: ${every.map(surface => surface.name).join(', ')}.`,
      );
    }
    const surfaces = wanted.length === 0 ? every : every.filter(surface => wanted.includes(surface.name));
    for (const surface of surfaces) {
      for (const size of SIZES) {
        const finding = await look({ app, surface, size, outDir });
        findings.push(finding);
        console.log(`${finding.problems.length === 0 ? 'ok   ' : 'look '} ${surface.name} ${size.label}`);
      }
    }
  } finally {
    await app.close();
  }
  const reportPath = join(outDir, 'report.md');
  await writeFile(reportPath, report(findings));
  console.log(`Pictures of ${String(findings.length)} screens are in ${outDir}. What to look at is in ${reportPath}.`);
}

await main();
