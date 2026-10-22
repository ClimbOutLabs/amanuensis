// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PRESETS } from '@/theme/presets/index.js';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider.js';
import { resolveHostTokens, type ThemeConfig } from '@/theme/types.js';

function ModeProbe() {
  const { setTheme } = useTheme();
  return (
    <button type="button" onClick={() => setTheme('dark')}>
      dark
    </button>
  );
}

function getThemeRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>('.aui-theme-root');
  if (root === null) {
    throw new Error('Expected theme root');
  }
  return root;
}

/** Forces `matchMedia` so the `'system'` state resolves to a known mode. */
function stubSystemPrefersDark(prefersDark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: prefersDark,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe('resolveHostTokens', () => {
  it('applies flat tokens in both modes', () => {
    const flat = { primaryBg: '#111111', radius: '0.5rem' };
    expect(resolveHostTokens(flat, 'light')).toEqual(flat);
    expect(resolveHostTokens(flat, 'dark')).toEqual(flat);
  });

  it('picks the set matching the active mode', () => {
    const split = { light: { primaryBg: '#ffffff' }, dark: { primaryBg: '#101010' } };
    expect(resolveHostTokens(split, 'light')).toEqual({ primaryBg: '#ffffff' });
    expect(resolveHostTokens(split, 'dark')).toEqual({ primaryBg: '#101010' });
  });

  it('leaves the preset untouched for a mode the host omits', () => {
    const lightOnly = { light: { primaryBg: '#ffffff' } };
    expect(resolveHostTokens(lightOnly, 'dark')).toEqual({});

    const darkOnly = { dark: { primaryBg: '#101010' } };
    expect(resolveHostTokens(darkOnly, 'light')).toEqual({});
  });

  it('ignores inherited light/dark keys when deciding the shape', () => {
    const flat = Object.create({ light: { primaryBg: '#ffffff' } }) as Record<string, string>;
    flat.primaryBg = '#222222';
    expect(resolveHostTokens(flat, 'dark')).toEqual({ primaryBg: '#222222' });
  });

  it('copies rather than aliasing the host config', () => {
    const flat = { primaryBg: '#222222' };
    const split = { dark: { primaryBg: '#101010' } };
    expect(resolveHostTokens(flat, 'dark')).not.toBe(flat);
    expect(resolveHostTokens(split, 'dark')).not.toBe(split.dark);
  });

  it('treats an absent config as no override', () => {
    expect(resolveHostTokens(undefined, 'light')).toEqual({});
    expect(resolveHostTokens(undefined, 'dark')).toEqual({});
  });
});

describe('ThemeProvider host token application', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.getElementById('trueforge-ui-styles')?.remove();
  });

  const splitTheme: ThemeConfig = {
    tokens: {
      light: { primaryBg: '#ffffff', sidebarBg: '#eeeeee' },
      dark: { primaryBg: '#101010' },
    },
  };

  it('renders the light set in explicit light mode', () => {
    const { container } = render(
      <ThemeProvider theme={{ ...splitTheme, mode: 'light' }}>
        <ModeProbe />
      </ThemeProvider>,
    );
    const root = getThemeRoot(container);
    expect(root).toHaveAttribute('data-theme', 'light');
    expect(root.style.getPropertyValue('--primary-bg')).toBe('#ffffff');
    expect(root.style.getPropertyValue('--sidebar-bg')).toBe('#eeeeee');
  });

  it('renders the dark set in explicit dark mode', () => {
    const { container } = render(
      <ThemeProvider theme={{ ...splitTheme, mode: 'dark' }}>
        <ModeProbe />
      </ThemeProvider>,
    );
    const root = getThemeRoot(container);
    expect(root).toHaveAttribute('data-theme', 'dark');
    expect(root.style.getPropertyValue('--primary-bg')).toBe('#101010');
    // No dark override for the sidebar, so the preset's dark value stands.
    expect(root.style.getPropertyValue('--sidebar-bg')).toBe(PRESETS.paper.dark.sidebarBg);
  });

  it('renders the dark set when the system reports dark and nothing is stored', () => {
    stubSystemPrefersDark(true);
    const { container } = render(
      <ThemeProvider theme={splitTheme}>
        <ModeProbe />
      </ThemeProvider>,
    );
    const root = getThemeRoot(container);
    expect(root).toHaveAttribute('data-theme', 'dark');
    expect(root.style.getPropertyValue('--primary-bg')).toBe('#101010');
  });

  it('renders the light set when the system reports light and nothing is stored', () => {
    stubSystemPrefersDark(false);
    const { container } = render(
      <ThemeProvider theme={splitTheme}>
        <ModeProbe />
      </ThemeProvider>,
    );
    const root = getThemeRoot(container);
    expect(root).toHaveAttribute('data-theme', 'light');
    expect(root.style.getPropertyValue('--primary-bg')).toBe('#ffffff');
  });

  it('swaps to the dark set when the toggle flips the mode', () => {
    stubSystemPrefersDark(false);
    const { container } = render(
      <ThemeProvider theme={splitTheme}>
        <ModeProbe />
      </ThemeProvider>,
    );
    const root = getThemeRoot(container);
    expect(root.style.getPropertyValue('--primary-bg')).toBe('#ffffff');
    act(() => {
      screen.getByRole('button', { name: 'dark' }).click();
    });
    expect(root.style.getPropertyValue('--primary-bg')).toBe('#101010');
  });

  it('keeps flat tokens applied across a mode flip', () => {
    stubSystemPrefersDark(false);
    const { container } = render(
      <ThemeProvider theme={{ tokens: { radius: '0.5rem' } }}>
        <ModeProbe />
      </ThemeProvider>,
    );
    const root = getThemeRoot(container);
    expect(root.style.getPropertyValue('--radius')).toBe('0.5rem');
    act(() => {
      screen.getByRole('button', { name: 'dark' }).click();
    });
    expect(root.style.getPropertyValue('--radius')).toBe('0.5rem');
    expect(root.style.getPropertyValue('--primary-bg')).toBe(PRESETS.paper.dark.primaryBg);
  });
});
