import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';
import { createServer, defaultClientConditions } from 'vite';

import { findChromiumExecutable } from './support/findChromiumExecutable.ts';

const RENDER_TIMEOUT_MS = 45_000;

/** Relative luminance of a CSS rgb() colour, for a WCAG contrast ratio. */
function luminance(rgb: string): number {
  const [r = 0, g = 0, b = 0] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast({ a, b }: { a: string; b: string }): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

test(
  'the right panel uses one body font, no Settings link, Activity above Rules, a clear fold button, and nothing over the picture',
  {
    timeout: 180_000,
  },
  async () => {
    const server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL('../', import.meta.url)),
      logLevel: 'silent',
      resolve: { conditions: ['trueforge-dev', ...defaultClientConditions] },
      server: { host: '127.0.0.1', port: 0 },
    });
    let browser: Browser | undefined;
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (address == null || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
      browser = await chromium.launch({ executablePath: findChromiumExecutable(), headless: true });
      for (const theme of ['light', 'dark'] as const) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/runtime-rail.fixture.html?theme=${theme}`, {
          waitUntil: 'domcontentloaded',
          timeout: RENDER_TIMEOUT_MS,
        });
        const panel = page.getByRole('complementary', { name: 'Amanuensis runtime status' });
        await panel.waitFor({ timeout: RENDER_TIMEOUT_MS });
        // Open every fold so all of the panel's text is rendered.
        for (const summary of await panel.locator('summary').all()) await summary.click();
        await panel.getByText('Sent an email').waitFor({ timeout: RENDER_TIMEOUT_MS });
        await page.waitForFunction(() => {
          const img = document.querySelector<HTMLImageElement>('.aman-runtime-rail__picture');
          return img?.complete === true && img.naturalWidth > 0;
        });

        const fonts = await panel.evaluate(root => {
          const families = new Set<string>();
          const spacing = new Set<string>();
          for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
            const hasText = Array.from(el.childNodes).some(
              node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
            );
            if (!hasText) continue;
            const style = getComputedStyle(el);
            families.add(style.fontFamily);
            spacing.add(style.letterSpacing);
          }
          return { families: [...families], spacing: [...spacing] };
        });
        assert.ok(
          fonts.families.length <= 2,
          `the panel renders at most two font families: ${fonts.families.join(' | ')}`,
        );
        assert.ok(
          fonts.families.every(family => !/mono|menlo|consolas/i.test(family)),
          `no monospace in the panel: ${fonts.families.join(' | ')}`,
        );
        assert.deepEqual(fonts.spacing, ['normal'], 'no letter spacing in the panel');

        assert.equal(await panel.getByRole('link', { name: /Settings/ }).count(), 0, 'no Settings link');
        const folds = await panel
          .locator('[data-section]')
          .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-section')));
        assert.ok(
          folds.indexOf('activity') < folds.indexOf('rules'),
          `Activity comes before Rules: ${folds.join(', ')}`,
        );
        assert.equal(await panel.locator('[data-section="memory"]').count(), 0, 'no Memory section');
        assert.equal(await panel.locator('[data-section="activity"] li').count(), 5, 'at most five actions');
        assert.equal(await panel.getByText(/·\s*\d/).count(), 0, 'no counts after an action');

        // Nothing sits over the picture: at its corners, edges and centre the topmost element is the picture.
        const covered = await page.evaluate(() => {
          const img = document.querySelector('.aman-runtime-rail__picture');
          if (img === null) return ['no picture'];
          const box = img.getBoundingClientRect();
          const inset = 4;
          const points: [number, number][] = [];
          for (const fx of [0, 0.5, 1]) {
            for (const fy of [0, 0.5, 0.9, 1]) {
              points.push([
                Math.min(box.right - inset, Math.max(box.left + inset, box.left + box.width * fx)),
                Math.min(box.bottom - inset, Math.max(box.top + inset, box.top + box.height * fy)),
              ]);
            }
          }
          return points
            .map(([x, y]) => ({ x, y, top: document.elementFromPoint(x, y) }))
            .filter(point => point.top !== img)
            .map(
              point =>
                `${String(Math.round(point.x))},${String(Math.round(point.y))} ${point.top?.className ?? 'nothing'}`,
            );
        });
        assert.deepEqual(covered, [], 'nothing overlaps the picture');
        const backgrounds = await panel.evaluate(root =>
          Array.from(root.querySelectorAll('*'))
            .map(el => getComputedStyle(el).backgroundImage)
            .filter(image => image.includes('gradient')),
        );
        assert.deepEqual(backgrounds, [], 'no gradient anywhere in the panel');

        // The fold button: a clear 2rem target with a visible edge, a label and a tooltip, kept after a reload.
        const hide = panel.getByRole('button', { name: 'Hide panel' });
        const box = await hide.boundingBox();
        assert.ok(box !== null && box.width >= 32 && box.height >= 32, 'the fold button is at least 2rem');
        assert.equal(await hide.getAttribute('title'), 'Hide panel');
        const colours = await hide.evaluate(button => {
          const style = getComputedStyle(button);
          const panelBg = getComputedStyle(button.closest('aside') ?? document.body).backgroundColor;
          return { fg: style.color, bg: style.backgroundColor, border: style.borderTopColor, panelBg };
        });
        assert.ok(contrast({ a: colours.fg, b: colours.bg }) >= 4.5, `the arrow reads against its button (${theme})`);
        assert.ok(colours.border !== colours.panelBg, `the button has a visible edge (${theme})`);

        await hide.click();
        const show = page.getByRole('button', { name: 'Show panel' });
        await show.waitFor({ timeout: RENDER_TIMEOUT_MS });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: 'Show panel' }).waitFor({ timeout: RENDER_TIMEOUT_MS });
        assert.ok(
          await page.getByRole('button', { name: 'Show panel' }).isVisible(),
          'folded, the button stays at the edge',
        );
        await page.getByRole('button', { name: 'Show panel' }).click();
        await page.close();
      }
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
