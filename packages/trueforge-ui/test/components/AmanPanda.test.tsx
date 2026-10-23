'use client';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { avatarAltText } from '@/components/AmanAvatarMotion.js';
import { AmanPandaRoundTicket } from '@/components/AmanPanda.js';

describe('AmanPandaRoundTicket', () => {
  it('uses the same accessible name as the rail avatar', () => {
    render(<AmanPandaRoundTicket src="/aman-avatar.png" name="Maya" />);

    expect(screen.getByRole('img', { name: avatarAltText('Maya') })).toHaveAttribute('src', '/aman-avatar.png');
  });

  it('renders nothing when the host gave no picture', () => {
    const { container } = render(<AmanPandaRoundTicket src={null} name="Maya" />);

    expect(container).toBeEmptyDOMElement();
  });
});
