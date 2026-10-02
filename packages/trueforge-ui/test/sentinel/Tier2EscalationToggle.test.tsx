// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Tier2EscalationToggle } from '@/sentinel/Tier2EscalationToggle.js';
import type { Tier2ActionKind } from '@/sentinel/types.js';

describe('Tier2EscalationToggle', () => {
  it('is off by default and reports the flip to the API', () => {
    const onChange = vi.fn(
      async (_input: { actionType: Tier2ActionKind; escalated: boolean }) => {},
    );
    render(<Tier2EscalationToggle actionType="file_write" escalated={false} onChange={onChange} />);
    const toggle = screen.getByRole('switch', { name: 'Always ask before file_write' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ actionType: 'file_write', escalated: true });
  });

  it('is on when the server escalates the kind, and flipping off reports it', () => {
    const onChange = vi.fn(
      async (_input: { actionType: Tier2ActionKind; escalated: boolean }) => {},
    );
    render(<Tier2EscalationToggle actionType="shell" escalated={true} onChange={onChange} />);
    const toggle = screen.getByRole('switch', { name: 'Always ask before shell' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ actionType: 'shell', escalated: false });
  });
});
