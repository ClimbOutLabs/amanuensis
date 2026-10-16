// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Tier2RelaxationToggle } from '@/sentinel/Tier2RelaxationToggle.js';
import type { Tier2ActionKind } from '@/sentinel/types.js';

describe('Tier2RelaxationToggle', () => {
  it('is off by default and reports the flip to the API', () => {
    const onChange = vi.fn(async (_input: { actionType: Tier2ActionKind; relaxed: boolean }) => {});
    render(<Tier2RelaxationToggle actionType="file_write" relaxed={false} onChange={onChange} />);
    const toggle = screen.getByRole('switch', { name: 'Always allow: file_write' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ actionType: 'file_write', relaxed: true });
  });

  it('is on when the server relaxes the kind, and flipping off reports it', () => {
    const onChange = vi.fn(async (_input: { actionType: Tier2ActionKind; relaxed: boolean }) => {});
    render(<Tier2RelaxationToggle actionType="file_write" relaxed={true} onChange={onChange} />);
    const toggle = screen.getByRole('switch', { name: 'Always allow: file_write' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ actionType: 'file_write', relaxed: false });
  });
});
