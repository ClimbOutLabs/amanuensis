import { describe, expect, it } from 'vitest';

import { PRESETS } from '@/theme/presets/index.js';

type Oklab = { l: number; a: number; b: number };
type Rgb = { r: number; g: number; b: number };

const AA_TEXT_RATIO = 4.5;
const GRADIENT_STEPS = 100;

/** Reads `#rrggbb` as linear sRGB. */
function hexToLinear(value: string): Rgb {
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`Unsupported colour "${value}": expected #rrggbb. Use a hex value in the preset.`);
  }
  const linear = (start: number): number => {
    const c = parseInt(value.slice(start, start + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return { r: linear(1), g: linear(3), b: linear(5) };
}

function isTriple(parts: number[]): parts is [number, number, number] {
  return parts.length === 3;
}

/** Reads `oklch(L C h)` as Oklab, the space CSS uses to interpolate gradients. */
function oklchToOklab(value: string): Oklab {
  const body = /^oklch\((.+)\)$/.exec(value)?.[1];
  const parts = body?.split(' ').map(Number) ?? [];
  if (!isTriple(parts)) {
    throw new Error(`Unsupported colour "${value}": expected oklch(L C h). Fix the preset value.`);
  }
  const [l, c, hue] = parts;
  const radians = (hue * Math.PI) / 180;
  return { l, a: c * Math.cos(radians), b: c * Math.sin(radians) };
}

function oklabToLinear({ l, a, b }: Oklab): Rgb {
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    g: -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    b: -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  };
}

function clampUnit({ r, g, b }: Rgb): Rgb {
  const clamp = (c: number) => Math.min(1, Math.max(0, c));
  return { r: clamp(r), g: clamp(g), b: clamp(b) };
}

function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(first: number, second: number): number {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * The glow is a radial gradient from `from` to `to`, so every point is a mix of the two in Oklab.
 * Sampling the whole mix finds the worst point rather than the average.
 */
function gradientLuminances(from: string, to: string): number[] {
  const start = oklchToOklab(from);
  const end = oklchToOklab(to);
  const samples: number[] = [];
  for (let step = 0; step <= GRADIENT_STEPS; step += 1) {
    const t = step / GRADIENT_STEPS;
    const mixed: Oklab = {
      l: start.l + (end.l - start.l) * t,
      a: start.a + (end.a - start.a) * t,
      b: start.b + (end.b - start.b) * t,
    };
    samples.push(luminance(clampUnit(oklabToLinear(mixed))));
  }
  return samples;
}

/** The caption is drawn on the glow, so its lowest-contrast point decides whether it passes. */
function worstCaptionContrast({ text, from, to }: { text: string; from: string; to: string }): number {
  const textLuminance = luminance(hexToLinear(text));
  return Math.min(...gradientLuminances(from, to).map(glow => contrastRatio(glow, textLuminance)));
}

// Both labels sit on the panda glow and take the primary text colour (`.aui-panda__role`).
const PANDA_LABELS = ['caption', 'waiting label'] as const;

describe('panda label contrast', () => {
  for (const label of PANDA_LABELS) {
    for (const [name, preset] of Object.entries(PRESETS)) {
      for (const mode of ['light', 'dark'] as const) {
        it(`${name} / ${mode}: ${label} passes AA at the worst point of the panda glow`, () => {
          const tokens = preset[mode];
          const ratio = worstCaptionContrast({
            text: tokens.textPrimary,
            from: tokens.pandaGlowFrom,
            to: tokens.pandaGlowTo,
          });
          expect(ratio).toBeGreaterThanOrEqual(AA_TEXT_RATIO);
        });
      }
    }
  }

  it('the contrast helper matches black on white', () => {
    expect(contrastRatio(luminance(hexToLinear('#ffffff')), luminance(hexToLinear('#000000')))).toBeCloseTo(21, 1);
  });
});
