import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HelpAreaChoices, toggleHelpAreaTopic } from '@/components/HelpAreaChoices.js';

describe('toggleHelpAreaTopic', () => {
  it('adds the first help area of a pill at the end, so the list keeps the order chosen', () => {
    expect(toggleHelpAreaTopic(['new_country'], 'someone_i_look_after')).toEqual(['new_country', 'family']);
  });

  it('removes every help area that leads to the pill and keeps the rest in order', () => {
    expect(toggleHelpAreaTopic(['focus', 'family', 'caring', 'work_money'], 'someone_i_look_after')).toEqual([
      'focus',
      'work_money',
    ]);
  });
});

describe('HelpAreaChoices', () => {
  it('offers one box for each pill a help area leads to, with none ticked when nothing is chosen', () => {
    render(<HelpAreaChoices idPrefix="test" value={[]} onChange={vi.fn()} />);

    expect(screen.getByRole('group', { name: 'What would help you most?' })).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map(box => box.closest('label')?.textContent)).toEqual([
      'Help me think',
      'Someone I look after',
      'Money',
      'I just moved here',
    ]);
    for (const box of boxes) expect(box).not.toBeChecked();
  });

  it('ticks a pill when either of its help areas is saved', () => {
    render(<HelpAreaChoices idPrefix="test" value={['caring']} onChange={vi.fn()} />);

    expect(screen.getByRole('checkbox', { name: 'Someone I look after' })).toBeChecked();
  });

  it('reports the new list when a box is ticked, and the list without it when unticked', () => {
    const onChange = vi.fn();
    const { rerender } = render(<HelpAreaChoices idPrefix="test" value={['family']} onChange={onChange} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'I just moved here' }));
    expect(onChange).toHaveBeenLastCalledWith(['family', 'new_country']);

    rerender(<HelpAreaChoices idPrefix="test" value={['family']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Someone I look after' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
