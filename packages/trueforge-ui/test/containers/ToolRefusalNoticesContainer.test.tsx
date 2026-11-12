// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolRefusalNoticesContainer } from '@/containers/ToolRefusalNoticesContainer.js';

const LINE = 'Nothing was sent: it did not say who gets it. The assistant needs to name each person.';

const notices = () => screen.queryAllByTestId('tool-refusal-notice').map(notice => notice.textContent);

describe('ToolRefusalNoticesContainer', () => {
  it('shows each line it is given, as a status', () => {
    render(<ToolRefusalNoticesContainer notices={[LINE, 'I could not finish one of the steps in this reply.']} />);
    expect(notices()).toEqual([LINE, 'I could not finish one of the steps in this reply.']);
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });

  it('shows nothing when it has no lines', () => {
    const { container } = render(<ToolRefusalNoticesContainer notices={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
