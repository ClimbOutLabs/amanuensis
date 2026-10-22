import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resolveThemePreset } from '@/theme/presets/index.js';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider.js';

const PRESET_STORAGE_KEY = 'aui-theme-preset';

/** Ids saved before the picker shrank, and the current theme each one now means. */
const LEGACY_MAPPINGS: Array<[string, string]> = [
  ['trueforge', 'paper'],
  ['claude', 'paper'],
  ['gemini', 'paper'],
  ['sunset', 'paper'],
  ['volt', 'paper'],
  ['chatgpt', 'high-contrast'],
  ['mint', 'high-contrast'],
];

const CURRENT_IDS = ['paper', 'forest', 'midnight', 'high-contrast'];

function PresetProbe() {
  const { preset, setPreset } = useTheme();
  return (
    <div>
      <output data-testid="preset">{preset}</output>
      <button type="button" onClick={() => setPreset('forest')}>
        pick forest
      </button>
    </div>
  );
}

describe('resolveThemePreset', () => {
  for (const [legacy, current] of LEGACY_MAPPINGS) {
    it(`maps the saved id "${legacy}" to "${current}"`, () => {
      expect(resolveThemePreset(legacy)).toBe(current);
    });
  }

  for (const id of CURRENT_IDS) {
    it(`keeps the current id "${id}"`, () => {
      expect(resolveThemePreset(id)).toBe(id);
    });
  }

  it('returns undefined for unknown ids, including Object.prototype keys', () => {
    expect(resolveThemePreset('nope')).toBeUndefined();
    expect(resolveThemePreset('constructor')).toBeUndefined();
    expect(resolveThemePreset('__proto__')).toBeUndefined();
  });
});

describe('stored preset migration', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  for (const [legacy, current] of LEGACY_MAPPINGS) {
    it(`a saved "${legacy}" preference opens as ${current}`, () => {
      window.localStorage.setItem(PRESET_STORAGE_KEY, legacy);
      const { container } = render(
        <ThemeProvider>
          <PresetProbe />
        </ThemeProvider>,
      );

      expect(screen.getByTestId('preset')).toHaveTextContent(current);
      expect(container.querySelector('.aui-theme-root')).toHaveAttribute('data-preset', current);
    });
  }

  it('falls back to the default when the saved value is unknown', () => {
    window.localStorage.setItem(PRESET_STORAGE_KEY, 'not-a-theme');
    render(
      <ThemeProvider>
        <PresetProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('preset')).toHaveTextContent('paper');
  });

  it('saves a new choice under the current id, replacing a legacy one', () => {
    window.localStorage.setItem(PRESET_STORAGE_KEY, 'claude');
    render(
      <ThemeProvider>
        <PresetProbe />
      </ThemeProvider>,
    );

    act(() => {
      screen.getByRole('button', { name: 'pick forest' }).click();
    });

    expect(screen.getByTestId('preset')).toHaveTextContent('forest');
    expect(window.localStorage.getItem(PRESET_STORAGE_KEY)).toBe('forest');
  });
});
