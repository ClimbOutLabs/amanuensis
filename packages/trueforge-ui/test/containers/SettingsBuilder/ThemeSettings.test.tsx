import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import ThemeSettings from '@/containers/SettingsBuilder/ThemeSettings.js';
import { ThemeProvider } from '@/theme/ThemeProvider.js';
import { MODEL_USAGE_DISPLAY_STORAGE_KEY, setModelUsageVisible } from '@/utils/modelUsageDisplayPreference.js';

const EXPECTED_LABELS = ['TrueForge', 'Claude', 'ChatGPT', 'Gemini', 'Midnight', 'Forest', 'Sunset', 'Volt'];

describe('ThemeSettings', () => {
  it('lists every theme preset with the Volt rename applied', () => {
    render(
      <ThemeProvider>
        <ThemeSettings />
      </ThemeProvider>,
    );

    for (const label of EXPECTED_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText('NVIDIA')).not.toBeInTheDocument();
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

    expect(screen.getByRole('switch', { name: 'Show model and cost under answers' })).toBeChecked();
  });

  it('switches the display off and back on, and remembers it', () => {
    renderSettings();
    const toggle = screen.getByRole('switch', { name: 'Show model and cost under answers' });

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
