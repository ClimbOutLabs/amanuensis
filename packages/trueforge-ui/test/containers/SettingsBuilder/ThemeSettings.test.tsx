import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import ThemeSettings from '@/containers/SettingsBuilder/ThemeSettings.js';
import { ThemeProvider } from '@/theme/ThemeProvider.js';
import { CHAT_FONT_SIZE_STORAGE_KEY } from '@/utils/chatFontSizePreference.js';
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

describe('ThemeSettings chat text size', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  function renderSettings() {
    return render(
      <ThemeProvider>
        <ThemeSettings />
      </ThemeProvider>,
    );
  }

  it('offers four sizes with the default one pressed', () => {
    renderSettings();

    expect(screen.getByRole('button', { name: 'Smaller' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Default' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Larger' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Largest' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('remembers the picked size and moves the pressed state to it', () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Larger' }));

    expect(window.localStorage.getItem(CHAT_FONT_SIZE_STORAGE_KEY)).toBe('larger');
    expect(screen.getByRole('button', { name: 'Larger' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Default' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('opens with a stored size already pressed', () => {
    window.localStorage.setItem(CHAT_FONT_SIZE_STORAGE_KEY, 'largest');
    renderSettings();

    expect(screen.getByRole('button', { name: 'Largest' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says only the chats change size', () => {
    renderSettings();

    expect(screen.getByText(/The rest of the app keeps its size/)).toBeInTheDocument();
  });

  it('shows a preview line at the picked size', () => {
    renderSettings();
    const preview = screen.getByText('This is how chat messages will look.');
    expect(preview.style.getPropertyValue('--text-base')).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Larger' }));

    expect(preview.style.getPropertyValue('--text-base')).toBe('1.0625rem');
  });

  it('labels the size buttons as one group', () => {
    renderSettings();

    const group = screen.getByRole('group', { name: 'Chat text size' });
    expect(within(group).getByRole('button', { name: 'Smaller' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Largest' })).toBeInTheDocument();
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
