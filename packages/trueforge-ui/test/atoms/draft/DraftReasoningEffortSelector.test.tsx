import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DraftReasoningEffortOptions } from '@/atoms/draft/DraftReasoningEffortSelector.js';

describe('DraftReasoningEffortOptions', () => {
  it('sizes the heading and the option rows on the type scale, not a one-off literal', () => {
    render(<DraftReasoningEffortOptions choices={{ efforts: ['low', 'high'], resolved: 'low', choose: vi.fn() }} />);

    const heading = screen.getByText('Reasoning effort');
    expect(heading).toHaveClass('text-xs');
    expect(heading.className).not.toMatch(/text-\[0\.75rem\]/);

    const option = screen.getByRole('option', { name: 'low' });
    expect(option).toHaveClass('text-sm');
    expect(option.className).not.toMatch(/text-\[0\.8125rem\]/);
  });
});
