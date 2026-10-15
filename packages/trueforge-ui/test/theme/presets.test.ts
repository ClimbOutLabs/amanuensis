import { describe, expect, it } from 'vitest';

import { PRESETS } from '@/theme/presets/index.js';
import type { SemanticTokens } from '@/theme/types.js';
import { TOKEN_CSS_VARS } from '@/theme/types.js';

/**
 * Regression guard: every exported theme preset must define every
 * SemanticTokens field for both modes, or the missing field would ship as an
 * undefined CSS variable at runtime. The list below mirrors the
 * SemanticTokens type in `src/theme/types.ts` (TOKEN_CSS_VARS is
 * `Record<keyof SemanticTokens, string>`, so adding a token to the type
 * without a CSS var name breaks the build; this test catches a token that
 * has a CSS var name but no value in some preset/mode). Keep this list in
 * sync with SemanticTokens whenever a token is added.
 */
const REQUIRED_TOKEN_KEYS: (keyof SemanticTokens)[] = [
  'sidebarBg',
  'sidebarText',
  'topbarBg',
  'primaryBg',
  'secondaryBg',
  'border',
  'fontFamily',
  'fontDisplay',
  'inputBoxBg',
  'inputBorder',
  'textPrimary',
  'textSecondary',
  'textXs',
  'textSm',
  'textBase',
  'textLg',
  'textXl',
  'text2xl',
  'cardBg',
  'surfaceElevated',
  'dropdownSelectedItemBg',
  'dropdownSelectedItemText',
  'userMessageBg',
  'userMessageText',
  'assistantMessageBg',
  'assistantMessageText',
  'primaryButtonBg',
  'primaryButtonHover',
  'primaryButtonText',
  'secondaryButtonBg',
  'secondaryButtonHover',
  'secondaryButtonText',
  'ghostButtonBg',
  'ghostButtonHover',
  'ghostButtonText',
  'successBg',
  'successText',
  'failureBg',
  'failureText',
  'warningBg',
  'warningText',
  'success',
  'warning',
  'danger',
  'dangerBg',
  'info',
  'infoBg',
  'recording',
  'chart1',
  'chart2',
  'chart3',
  'chart4',
  'chart5',
  'chart6',
  'chart7',
  'chart8',
  'focusRing',
  'radius',
  'composerRadius',
  'overlay',
  'shadowColor',
  'scrollbarThumb',
];

const MODES = ['light', 'dark'] as const;

describe('theme preset token coverage', () => {
  it('required-key list matches the SemanticTokens type (via TOKEN_CSS_VARS)', () => {
    expect([...REQUIRED_TOKEN_KEYS].sort()).toEqual(Object.keys(TOKEN_CSS_VARS).sort());
  });

  for (const [presetName, preset] of Object.entries(PRESETS)) {
    for (const mode of MODES) {
      it(`${presetName} / ${mode} defines every SemanticTokens key`, () => {
        const tokens: SemanticTokens = preset[mode];
        for (const key of REQUIRED_TOKEN_KEYS) {
          const value = tokens[key];
          expect(typeof value, `${presetName}/${mode} missing token: ${key}`).toBe('string');
          expect(value.length, `${presetName}/${mode} empty token: ${key}`).toBeGreaterThan(0);
        }
      });
    }
  }
});
