import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ShellActions } from '@/atoms/ShellActions.js';
import { ThemeProvider } from '@/theme/ThemeProvider.js';
import { TOUR_HIDDEN_STORAGE_KEY } from '@/utils/tourDisplayPreference.js';

function renderActions() {
  return render(
    <ThemeProvider theme={{ mode: 'light', brand: { mode: 'icon-title', name: 'Amanuensis' } }}>
      <ShellActions />
    </ThemeProvider>,
  );
}

afterEach(() => {
  window.localStorage.clear();
});

describe('ShellActions tour entry', () => {
  it('offers Replay the tour only while the owner has the tour hidden', () => {
    renderActions();
    expect(screen.queryByRole('button', { name: 'Replay the tour' })).not.toBeInTheDocument();
  });

  it('brings the tour back from the footer and clears the stored hide', () => {
    window.localStorage.setItem(TOUR_HIDDEN_STORAGE_KEY, 'true');
    renderActions();

    fireEvent.click(screen.getByRole('button', { name: 'Replay the tour' }));

    expect(screen.queryByRole('button', { name: 'Replay the tour' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(TOUR_HIDDEN_STORAGE_KEY)).toBe('false');
  });
});
