import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LightDarkToggleButton } from '@/atoms/LightDarkToggleButton.js';
import { ThemeProvider } from '@/theme/ThemeProvider.js';

function renderButton() {
  return render(
    <ThemeProvider>
      <LightDarkToggleButton />
    </ThemeProvider>,
  );
}

function shownMode(container: HTMLElement) {
  return container.querySelector('[data-theme]')?.getAttribute('data-theme');
}

describe('LightDarkToggleButton', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers Switch to dark while light is showing, and one tap makes it dark', () => {
    const { container } = renderButton();

    expect(shownMode(container)).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark' }));

    expect(shownMode(container)).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light' })).toBeInTheDocument();
  });

  it('keeps the flipped choice after a reload', () => {
    const first = renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark' }));
    first.unmount();

    const second = renderButton();
    expect(shownMode(second.container)).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light' }));
    expect(shownMode(second.container)).toBe('light');
  });

  it('is not shown on a phone, where the header has no room for it', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query === '(max-width: 767px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })),
    );
    renderButton();

    expect(screen.queryByRole('button', { name: /Switch to/ })).toBeNull();
  });
});
