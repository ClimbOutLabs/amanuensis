import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DraftComposerActionsMenu } from '@/atoms/draft/DraftComposerActionsMenu.js';

describe('DraftComposerActionsMenu', () => {
  it('sizes the trigger and the menu items on the --text-sm scale step, not a one-off literal', () => {
    render(
      <DraftComposerActionsMenu
        actions={[{ id: 'attach', label: 'Attach files', icon: 'paperclip', onSelect: vi.fn() }]}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Add' });
    expect(trigger).toHaveClass('text-sm');
    expect(trigger.className).not.toMatch(/text-\[0\.8125rem\]/);

    fireEvent.click(trigger);
    const item = screen.getByText('Attach files');
    expect(item).toHaveClass('text-sm');
    expect(item.className).not.toMatch(/text-\[0\.8125rem\]/);
  });

  it('renders nothing with no actions', () => {
    const { container } = render(<DraftComposerActionsMenu actions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
