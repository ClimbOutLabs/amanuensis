// @vitest-environment jsdom
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShellActions } from '@/atoms/ShellActions.js';
import { WelcomeScreen } from '@/atoms/WelcomeScreen.js';
import { BrandLogo } from '@/theme/brand.js';
import { ThemeProvider, useBrand, useTheme } from '@/theme/ThemeProvider.js';

function ModeProbe() {
  const { mode, preference, setTheme } = useTheme();
  return (
    <div>
      <output data-testid="mode">{mode}</output>
      <output data-testid="preference">{preference}</output>
      <button type="button" onClick={() => setTheme('dark')}>
        dark
      </button>
      <button type="button" onClick={() => setTheme('system')}>
        system
      </button>
    </div>
  );
}

function BrandProbe() {
  const brand = useBrand();
  return <output data-testid="brand-name">{brand.name ?? 'none'}</output>;
}

function getThemeRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>('.aui-theme-root');
  if (root === null) {
    throw new Error('Expected theme root');
  }
  return root;
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    document.documentElement.classList.remove('dark');
    document.getElementById('trueforge-ui-styles')?.remove();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.documentElement.classList.remove('dark');
    document.getElementById('trueforge-ui-styles')?.remove();
  });

  it('applies controlled dark mode on the theme root only', () => {
    const { container } = render(
      <ThemeProvider theme={{ mode: 'dark' }}>
        <ModeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(getThemeRoot(container)).toHaveClass('dark');
    expect(getThemeRoot(container)).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('requires a provider for useTheme', () => {
    expect(() => renderHook(() => useTheme())).toThrow('useTheme must be used within a ThemeProvider');
  });

  it('applies controlled mode and ignores setTheme', () => {
    render(
      <ThemeProvider theme={{ mode: 'dark' }}>
        <ModeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    act(() => {
      screen.getByRole('button', { name: 'system' }).click();
    });
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
  });

  it('toggles mode when uncontrolled', () => {
    render(
      <ThemeProvider>
        <ModeProbe />
      </ThemeProvider>,
    );
    act(() => {
      screen.getByRole('button', { name: 'dark' }).click();
    });
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(getThemeRoot(document.body).classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('aui-theme-preference')).toBe('dark');
  });

  it('persists theme toggle to localStorage and restores on remount', () => {
    const { unmount, container } = render(
      <ThemeProvider>
        <ModeProbe />
      </ThemeProvider>,
    );
    // Toggle to dark
    act(() => {
      screen.getByRole('button', { name: 'dark' }).click();
    });
    expect(getThemeRoot(container).classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('aui-theme-preference')).toBe('dark');

    // Unmount and remount
    unmount();
    const { container: container2 } = render(
      <ThemeProvider>
        <ModeProbe />
      </ThemeProvider>,
    );
    // Should restore dark mode from localStorage
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(getThemeRoot(container2).classList.contains('dark')).toBe(true);
  });

  it('follows system preference changes and removes the listener on unmount', () => {
    let systemDark = false;
    const listeners = new Set<() => void>();
    const addEventListener = vi.fn((_type: string, listener: () => void) => {
      listeners.add(listener);
    });
    const removeEventListener = vi.fn((_type: string, listener: () => void) => {
      listeners.delete(listener);
    });
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return systemDark;
        },
        addEventListener,
        removeEventListener,
      })),
    );
    localStorage.setItem('aui-theme-preference', 'system');

    const { unmount, container } = render(
      <ThemeProvider>
        <ModeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('preference')).toHaveTextContent('system');
    expect(screen.getByTestId('mode')).toHaveTextContent('light');
    expect(getThemeRoot(container).classList.contains('dark')).toBe(false);

    systemDark = true;
    act(() => {
      for (const listener of listeners) listener();
    });

    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(getThemeRoot(container).classList.contains('dark')).toBe(true);

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('exposes brand config and labels BrandLogo with the brand name', () => {
    render(
      <ThemeProvider theme={{ brand: { mode: 'icon-title', name: 'Acme', icon: '/acme.svg' } }}>
        <BrandProbe />
        <BrandLogo className="size-4" />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('brand-name')).toHaveTextContent('Acme');
    expect(screen.getByRole('img', { name: 'Acme' })).toHaveAttribute('src', '/acme.svg');
  });

  it('writes token CSS vars on the theme root', () => {
    const { container } = render(
      <ThemeProvider theme={{ tokens: { primaryButtonBg: '#e11d48' }, className: 'host-chat' }}>
        <span>child</span>
      </ThemeProvider>,
    );
    const root = getThemeRoot(container);
    expect(root.classList.contains('host-chat')).toBe(true);
    expect(root.style.getPropertyValue('--primary-button-bg')).toBe('#e11d48');
  });

  it('applies every preset palette', () => {
    const cases: Array<{
      name: string;
      preset: 'chatgpt' | 'claude' | 'gemini';
      mode: 'light' | 'dark';
      dataPreset?: string;
      inlineFontFamily?: string;
      tokens: Record<string, string>;
    }> = [
      {
        name: 'ChatGPT light',
        preset: 'chatgpt',
        mode: 'light',
        dataPreset: 'chatgpt',
        inlineFontFamily: '',
        tokens: {
          '--primary-button-bg': '#0d0d0d',
          '--primary-bg': '#ffffff',
          '--font-agent-ui':
            '"GeistSans", "GeistSans Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
          '--radius': '1.5rem',
          '--composer-radius': '1.75rem',
          '--user-message-bg': '#e9e9e980',
          '--user-message-text': '#0d0d0d',
          '--input-box-bg': '#ffffff',
        },
      },
      {
        name: 'ChatGPT dark',
        preset: 'chatgpt',
        mode: 'dark',
        tokens: {
          '--primary-bg': '#000000',
          '--card-bg': '#212121',
          '--primary-button-bg': '#ffffff',
          '--secondary-bg': '#303030',
          '--user-message-bg': '#323232',
          '--user-message-text': '#ffffff',
        },
      },
      {
        name: 'Claude light',
        preset: 'claude',
        mode: 'light',
        dataPreset: 'claude',
        tokens: {
          '--primary-bg': '#f0ece0',
          '--text-primary': '#1a1a18',
          '--card-bg': '#ffffff',
          '--primary-button-bg': '#c96442',
          '--font-agent-ui': "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          '--font-display': "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif",
          '--radius': '1rem',
          '--composer-radius': '1rem',
          '--user-message-bg': '#e5e0d6',
          '--user-message-text': '#1a1a18',
        },
      },
      {
        name: 'Claude dark',
        preset: 'claude',
        mode: 'dark',
        tokens: {
          '--primary-bg': '#2b2a27',
          '--text-primary': '#eeeeee',
          '--card-bg': '#1f1e1b',
          '--primary-button-bg': '#c96442',
          '--user-message-bg': '#3d3a35',
          '--user-message-text': '#eeeeee',
        },
      },
      {
        name: 'Gemini light',
        preset: 'gemini',
        mode: 'light',
        tokens: {
          '--primary-bg': '#fdfcfc',
          '--text-primary': '#1f1f1f',
          '--primary-button-bg': '#1f3b9b',
          '--font-agent-ui':
            '"GeistSans", "GeistSans Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
          '--radius': '1rem',
          '--composer-radius': '2rem',
          '--user-message-bg': '#f3f6fc',
        },
      },
      {
        name: 'Gemini dark',
        preset: 'gemini',
        mode: 'dark',
        tokens: {
          '--primary-bg': '#0c0c0c',
          '--card-bg': '#1e1f20',
          '--primary-button-bg': '#a8c7fa',
          '--primary-button-text': '#062e6f',
          '--focus-ring': '#a8c7fa',
          '--user-message-bg': '#222327',
        },
      },
    ];

    for (const palette of cases) {
      const { container, unmount } = render(
        <ThemeProvider theme={{ preset: palette.preset, mode: palette.mode }}>
          <span>child</span>
        </ThemeProvider>,
      );
      const root = getThemeRoot(container);

      if (palette.dataPreset !== undefined) {
        expect(root.getAttribute('data-preset'), `${palette.name}: data-preset`).toBe(palette.dataPreset);
      }
      if (palette.inlineFontFamily !== undefined) {
        expect(root.style.fontFamily, `${palette.name}: inline font family`).toBe(palette.inlineFontFamily);
      }
      for (const [token, value] of Object.entries(palette.tokens)) {
        expect(root.style.getPropertyValue(token), `${palette.name}: ${token}`).toBe(value);
      }

      unmount();
    }
  });

  it('applies dark class on first render when matchMedia reports dark and no stored preference', () => {
    const listeners = new Set<() => void>();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return true; // System reports dark
        },
        addEventListener: (_type: string, listener: () => void) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: () => void) => {
          listeners.delete(listener);
        },
      })),
    );
    localStorage.clear();

    const { container } = render(
      <ThemeProvider>
        <ModeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(getThemeRoot(container)).toHaveClass('dark');
    expect(getThemeRoot(container)).toHaveAttribute('data-theme', 'dark');
  });

  it('does not apply dark class on first render when matchMedia reports light and no stored preference', () => {
    const listeners = new Set<() => void>();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return false; // System reports light
        },
        addEventListener: (_type: string, listener: () => void) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: () => void) => {
          listeners.delete(listener);
        },
      })),
    );
    localStorage.clear();

    const { container } = render(
      <ThemeProvider>
        <ModeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('mode')).toHaveTextContent('light');
    expect(getThemeRoot(container)).not.toHaveClass('dark');
    expect(getThemeRoot(container)).toHaveAttribute('data-theme', 'light');
  });

  it('resolves to defaultMode when nothing is stored and system prefers dark', () => {
    const listeners = new Set<() => void>();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return true; // System reports dark
        },
        addEventListener: (_type: string, listener: () => void) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: () => void) => {
          listeners.delete(listener);
        },
      })),
    );
    localStorage.clear();

    render(
      <ThemeProvider theme={{ defaultMode: 'light' }}>
        <ModeProbe />
        <ShellActions />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('mode')).toHaveTextContent('light');
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument();
  });

  it('lets a stored preference win over defaultMode', () => {
    localStorage.setItem('aui-theme-preference', 'dark');

    render(
      <ThemeProvider theme={{ defaultMode: 'light' }}>
        <ModeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('preference')).toHaveTextContent('dark');
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
  });

  it('stores the preference and flips mode when toggled with a defaultMode set', () => {
    localStorage.clear();

    render(
      <ThemeProvider theme={{ defaultMode: 'light' }}>
        <ModeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('mode')).toHaveTextContent('light');
    act(() => {
      screen.getByRole('button', { name: 'dark' }).click();
    });
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(localStorage.getItem('aui-theme-preference')).toBe('dark');
  });

  it('falls back to system when no defaultMode is given, unchanged from before', () => {
    const listeners = new Set<() => void>();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return true; // System reports dark
        },
        addEventListener: (_type: string, listener: () => void) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: () => void) => {
          listeners.delete(listener);
        },
      })),
    );
    localStorage.clear();

    render(
      <ThemeProvider>
        <ModeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('preference')).toHaveTextContent('system');
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
  });

  it('applies every preset welcome treatment', () => {
    const trueforge = render(
      <ThemeProvider theme={{ preset: 'trueforge', mode: 'light' }}>
        <WelcomeScreen />
      </ThemeProvider>,
    );

    expect(getThemeRoot(trueforge.container).style.getPropertyValue('--font-agent-ui')).toBe(
      `'Inter Tight', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`,
    );
    expect(getThemeRoot(trueforge.container).style.getPropertyValue('--sidebar-text')).toBe('#2c2a26');
    expect(getThemeRoot(trueforge.container).style.getPropertyValue('--radius')).toBe('0.65rem');
    expect(screen.getByRole('heading', { name: 'How can I help you today?' })).toHaveClass('font-semibold');
    trueforge.unmount();

    const chatgpt = render(
      <ThemeProvider theme={{ preset: 'chatgpt', mode: 'light' }}>
        <WelcomeScreen />
      </ThemeProvider>,
    );
    expect(screen.getByRole('heading', { name: 'How can I help you today?' })).toHaveClass('font-normal');
    expect(chatgpt.container.querySelector('.aui-thread-welcome-root')).toHaveAttribute('data-preset', 'chatgpt');
    chatgpt.unmount();

    const claude = render(
      <ThemeProvider theme={{ preset: 'claude', mode: 'light' }}>
        <WelcomeScreen />
      </ThemeProvider>,
    );
    expect(claude.container.querySelector('.aui-thread-welcome-root svg')).toHaveClass('fill-current');
    claude.unmount();

    const gemini = render(
      <ThemeProvider theme={{ preset: 'gemini', mode: 'dark' }}>
        <WelcomeScreen />
      </ThemeProvider>,
    );
    expect(screen.getByRole('heading', { name: 'How can I help you today?' })).toHaveClass(
      'font-normal',
      'duration-300',
    );
    expect(gemini.container.querySelector('[aria-hidden].motion-safe\\:animate-pulse')).toBeInTheDocument();
    gemini.unmount();
  });
});
