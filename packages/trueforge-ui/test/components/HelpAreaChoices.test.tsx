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
  it('offers the five areas under the question, with none ticked when nothing is chosen', () => {
    render(<HelpAreaChoices idPrefix="test" value={[]} onChange={vi.fn()} />);

    expect(screen.getByRole('group', { name: 'What would help you most?' })).toBeInTheDocument();
    for (const label of [
      'Focus and getting started',
      'Family and home',
      'Caring for someone',
      'New to a country',
      'Work and money',
    ]) {
      expect(screen.getByRole('checkbox', { name: label })).not.toBeChecked();
    }
  });

  it('reports the new list when a box is ticked, and the list without it when unticked', () => {
    const onChange = vi.fn();
    const { rerender } = render(<HelpAreaChoices idPrefix="test" value={['family']} onChange={onChange} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Work and money' }));
    expect(onChange).toHaveBeenLastCalledWith(['family', 'work_money']);

    rerender(<HelpAreaChoices idPrefix="test" value={['family']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Family and home' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
