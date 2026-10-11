import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ThemeSettings from '@/containers/SettingsBuilder/ThemeSettings.js';
import { ThemeProvider } from '@/theme/ThemeProvider.js';

const EXPECTED_LABELS = ['Paper', 'Cream', 'Contrast', 'Slate', 'Midnight', 'Forest', 'Sunset', 'Volt'];

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
