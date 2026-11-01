import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import ThemeSettings from '@/containers/SettingsBuilder/ThemeSettings.js';
import { ThemeProvider } from '@/theme/ThemeProvider.js';
import { MODEL_USAGE_DISPLAY_STORAGE_KEY, setModelUsageVisible } from '@/utils/modelUsageDisplayPreference.js';

const PICKER_CARDS = [
  { label: 'Paper', description: 'Warm paper, ink and gold' },
  { label: 'Forest', description: 'Calm greens, natural tones' },
  { label: 'Midnight', description: 'Deep blue-grays, ice blue accents' },
  { label: 'High contrast', description: 'Maximum legibility, stark surfaces' },
];

describe('ThemeSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('shows four theme cards in order with their descriptions', () => {
    render(
      <ThemeProvider>
        <ThemeSettings />
      </ThemeProvider>,
    );

    const cards = screen.getAllByRole('button', { name: /^(Paper|Forest|Midnight|High contrast)\b/ });
    const labelsInOrder = cards.map(card =>
      PICKER_CARDS.find(
        ({ label, description }) =>
          within(card).queryByText(label) !== null && within(card).queryByText(description) !== null,
      ),
    );
    expect(labelsInOrder).toEqual(PICKER_CARDS);
  });

  it('switches the preset as soon as a card is chosen and remembers it', () => {
    const { container } = render(
      <ThemeProvider>
        <ThemeSettings />
      </ThemeProvider>,
    );
    const root = container.querySelector('.aui-theme-root');
    expect(root).toHaveAttribute('data-preset', 'paper');

    fireEvent.click(screen.getByRole('button', { name: /High contrast/ }));

    expect(root).toHaveAttribute('data-preset', 'high-contrast');
    expect(screen.getByRole('button', { name: /High contrast/ })).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem('aui-theme-preset')).toBe('high-contrast');
  });
});

describe('ThemeSettings model and cost switch', () => {
  beforeEach(() => {
    window.localStorage.removeItem(MODEL_USAGE_DISPLAY_STORAGE_KEY);
    setModelUsageVisible(true);
  });

  function renderSettings() {
    return render(
      <ThemeProvider>
        <ThemeSettings />
      </ThemeProvider>,
    );
  }

  it('is on by default', () => {
    window.localStorage.removeItem(MODEL_USAGE_DISPLAY_STORAGE_KEY);
    renderSettings();

    expect(screen.getByRole('switch', { name: 'Show model and cost in answer details' })).toBeChecked();
  });

  it('switches the display off and back on, and remembers it', () => {
    renderSettings();
    const toggle = screen.getByRole('switch', { name: 'Show model and cost in answer details' });

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(window.localStorage.getItem(MODEL_USAGE_DISPLAY_STORAGE_KEY)).toBe('false');

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(window.localStorage.getItem(MODEL_USAGE_DISPLAY_STORAGE_KEY)).toBe('true');
  });

  it('says hiding it changes only what is shown', () => {
    renderSettings();

    expect(screen.getByText(/usage is still counted/)).toBeInTheDocument();
  });
});
