import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { AppearanceChoices } from '@/atoms/AppearanceChoices.js';
import { ThemeProvider } from '@/theme/ThemeProvider.js';

function renderChoices() {
  return render(
    <ThemeProvider>
      <AppearanceChoices />
    </ThemeProvider>,
  );
}

function checkedChoice() {
  return within(screen.getByRole('group', { name: 'Appearance' }))
    .getAllByRole('menuitemradio')
    .filter(choice => choice.getAttribute('aria-checked') === 'true')
    .map(choice => choice.textContent);
}

describe('AppearanceChoices', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('offers Light, Dark and Match my computer, with Match my computer checked by default', () => {
    renderChoices();

    const choices = within(screen.getByRole('group', { name: 'Appearance' })).getAllByRole('menuitemradio');
    expect(choices.map(choice => choice.textContent)).toEqual(['Light', 'Dark', 'Match my computer']);
    expect(checkedChoice()).toEqual(['Match my computer']);
  });

  it('moves the check to the chosen appearance and keeps it after a reload', () => {
    const first = renderChoices();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    expect(checkedChoice()).toEqual(['Dark']);
    first.unmount();

    renderChoices();
    expect(checkedChoice()).toEqual(['Dark']);
  });
});
