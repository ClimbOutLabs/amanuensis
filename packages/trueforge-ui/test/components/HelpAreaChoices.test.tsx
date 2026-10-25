import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HelpAreaChoices, toggleHelpArea } from '@/components/HelpAreaChoices.js';

describe('toggleHelpArea', () => {
  it('adds a new area to the end, so the list keeps the order chosen', () => {
    expect(toggleHelpArea(['family'], 'focus')).toEqual(['family', 'focus']);
  });

  it('removes an area that is already chosen and keeps the rest in order', () => {
    expect(toggleHelpArea(['family', 'focus', 'caring'], 'focus')).toEqual(['family', 'caring']);
  });
});

describe('HelpAreaChoices', () => {
  it('offers only the areas that show as home pills, with none ticked when nothing is chosen', () => {
    render(<HelpAreaChoices idPrefix="test" value={[]} onChange={vi.fn()} />);

    expect(screen.getByRole('group', { name: 'What would help you most?' })).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map(box => box.closest('label')?.textContent)).toEqual(['Family and home', 'New to a country']);
    for (const box of boxes) expect(box).not.toBeChecked();
  });

  it('reports the new list when a box is ticked, and the list without it when unticked', () => {
    const onChange = vi.fn();
    const { rerender } = render(<HelpAreaChoices idPrefix="test" value={['family']} onChange={onChange} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'New to a country' }));
    expect(onChange).toHaveBeenLastCalledWith(['family', 'new_country']);

    rerender(<HelpAreaChoices idPrefix="test" value={['family']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Family and home' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
