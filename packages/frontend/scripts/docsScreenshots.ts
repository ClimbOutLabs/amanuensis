/**
 * Takes every screenshot the help docs need, with the demo world from docsScreenshots/demoWorld.ts, at a
 * computer size and a phone size. This is a tool, not a test: run it with `pnpm docs:screenshots`, or
 * `pnpm docs:screenshots memory-list chats-list` for just those shots.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from 'playwright-core';

import { DESKTOP, PHONE, startDemoApp, type ScreenSize } from './docsScreenshots/demoApp.ts';
import { TEST_WORDS } from './docsScreenshots/demoWorld.ts';
import { SHOTS, type Shot, type World } from './docsScreenshots/shots.ts';
import { settle, STEP_TIMEOUT_MS, type StepContext } from './docsScreenshots/steps.ts';

const OUTPUT_DIR = fileURLToPath(new URL('../../../docs/screenshots/app/', import.meta.url));
const SIZES: readonly ScreenSize[] = [DESKTOP, PHONE];
const WORLDS: readonly World[] = ['empty', 'model', 'full'];
/** Room left around a cropped part, in CSS pixels. More would take in a sliver of the parts next to it. */
const CROP_MARGIN = 0;

function shotsToTake(names: readonly string[]): readonly Shot[] {
  if (names.length === 0) return SHOTS;
  const unknown = names.filter(name => !SHOTS.some(shot => shot.name === name));
  if (unknown.length > 0) {
    throw new Error(`There is no shot named ${unknown.join(', ')}. Add it to scripts/docsScreenshots/shots.ts first.`);
  }
  return SHOTS.filter(shot => names.includes(shot.name));
}

/** The window area that holds every crop selector's last visible match, with a small margin. */
async function cropArea({ page, selectors }: { page: Page; selectors: readonly string[] }) {
  let area: { left: number; top: number; right: number; bottom: number } | undefined;
  for (const selector of selectors) {
    const box = await page.locator(selector).locator('visible=true').last().boundingBox({ timeout: STEP_TIMEOUT_MS });
    if (box === null) throw new Error(`Nothing on screen matches the crop "${selector}".`);
    area = {
      left: Math.min(area?.left ?? box.x, box.x),
      top: Math.min(area?.top ?? box.y, box.y),
      right: Math.max(area?.right ?? box.x + box.width, box.x + box.width),
      bottom: Math.max(area?.bottom ?? box.y + box.height, box.y + box.height),
    };
  }
  const viewport = page.viewportSize();
  if (area === undefined || viewport === null) return undefined;
  const left = Math.max(0, area.left - CROP_MARGIN);
  const top = Math.max(0, area.top - CROP_MARGIN);
  return {
    x: left,
    y: top,
    width: Math.min(viewport.width, area.right + CROP_MARGIN) - left,
    height: Math.min(viewport.height, area.bottom + CROP_MARGIN) - top,
  };
}

async function takeShot({
  shot,
  size,
  context,
}: {
  shot: Shot;
  size: ScreenSize;
  context: StepContext;
}): Promise<string> {
  for (const step of shot.steps) await step(context);
  await settle(context.page);
  const shown = await context.page.locator('body').innerText();
  const found = TEST_WORDS.filter(word => shown.includes(word));
  if (found.length > 0) {
    throw new Error(`The screen shows test text (${found.join(', ')}).`);
  }
  const path = join(OUTPUT_DIR, `${shot.name}-${size.label}.png`);
  const clip = shot.crop === undefined ? undefined : await cropArea({ page: context.page, selectors: shot.crop });
  await context.page.screenshot({
    path,
    animations: 'disabled',
    caret: 'hide',
    ...(clip === undefined ? {} : { clip }),
  });
  return path;
}

async function main(): Promise<void> {
  const shots = shotsToTake(process.argv.slice(2));
  const started = Date.now();
  // A picture of each screen that failed, kept after the run so it can be looked at.
  const failedDir = await mkdtemp(join(tmpdir(), 'aman-docs-shots-failed-'));
  const app = await startDemoApp('docs-screenshots');
  const problems: string[] = [];
  let taken = 0;
  try {
    await mkdir(OUTPUT_DIR, { recursive: true });
    for (const world of WORLDS) {
      const inWorld = shots.filter(candidate => candidate.world === world);
      if (world === 'model') await app.addModel();
      if (world === 'full' && inWorld.length > 0) {
        console.log('Setting up the demo world...');
        await app.addEverything();
      }
      for (const shot of inWorld) {
        // Both sizes of one shot are taken together, so a step that changes the world changes it for both.
        for (const size of SIZES) {
          if (shot.computerOnly === true && size.phone) continue;
          const context = await app.newContext(size);
          const page = await context.newPage();
          const failures: string[] = [];
          page.on('pageerror', error => failures.push(`page error: ${error.message}`));
          page.on('response', response => {
            if (response.status() >= 500 && response.url().includes('/api/')) {
              failures.push(`${String(response.status())} from ${response.url()}`);
            }
          });
          taken += 1;
          try {
            const path = await takeShot({
              shot,
              size,
              context: { page, origin: app.origin, phone: size.phone, api: app.api, owner: app.owner },
            });
            console.log(`saved ${path}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push(message.split('\n')[0] ?? message);
            await page.screenshot({ path: join(failedDir, `${shot.name}-${size.label}.png`) }).catch(() => undefined);
          }
          problems.push(...failures.map(failure => `${shot.name} ${size.label}: ${failure}`));
          await context.close();
        }
      }
    }
  } finally {
    await app.close();
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`Took ${String(taken)} screenshots in ${String(seconds)} seconds.`);
  if (problems.length > 0) {
    console.error(`Some screens need a look. Pictures of them are in ${failedDir}.\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    await rm(failedDir, { recursive: true, force: true });
  }
}

await main();
