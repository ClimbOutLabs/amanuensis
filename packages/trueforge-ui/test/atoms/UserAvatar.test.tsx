import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { getUserInitials, UserAvatar } from '@/atoms/UserAvatar.js';
import { PersonalizationProvider, type PersonalizationProfile } from '@/components/PersonalizationContext.js';
import { CurrentUserProvider } from '@/contexts/CurrentUserContext.js';

describe('getUserInitials', () => {
  it.each([
    ['Ada Lovelace', 'A'],
    ['Ada King Lovelace', 'A'],
    ['Ada', 'A'],
    ['bob', 'B'],
    ['  ada   lovelace  ', 'A'],
    ['', ''],
    ['   ', ''],
  ])('returns the first character for %j', (displayName, expected) => {
    expect(getUserInitials(displayName)).toBe(expected);
  });
});

describe('UserAvatar', () => {
  it('shows the first character with the full display name underneath', () => {
    render(
      <CurrentUserProvider currentUser={{ displayName: 'Ada Lovelace' }}>
        <UserAvatar labeled />
      </CurrentUserProvider>,
    );

    const avatar = screen.getByLabelText('Ada Lovelace');
    expect(avatar).toHaveTextContent('A');
    expect(avatar).toHaveTextContent('Ada Lovelace');
    expect(avatar).toHaveAttribute('title', 'Ada Lovelace');
    expect(avatar).toHaveClass('w-14.5');
  });

  it('renders nothing without a non-empty display name', () => {
    const { container, rerender } = render(<UserAvatar />);
    expect(container).toBeEmptyDOMElement();

    rerender(
      <CurrentUserProvider currentUser={{ displayName: '   ' }}>
        <UserAvatar />
      </CurrentUserProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the name the person asked to be called instead of the sign-in name', async () => {
    const profile: PersonalizationProfile = {
      assistant_name: null,
      assistant_identity: null,
      voice_guidance: null,
      user_name: 'Ada Lovelace',
      address_as: 'Ada',
      user_profile: null,
      pinned_preferences: [],
      help_areas: [],
      learned_profile: null,
    };
    render(
      <PersonalizationProvider
        api={{ getProfile: async () => profile, updateProfile: async next => next, deleteProfile: async () => {} }}
      >
        <CurrentUserProvider currentUser={{ displayName: 'maria@example.com' }}>
          <UserAvatar labeled />
        </CurrentUserProvider>
      </PersonalizationProvider>,
    );

    expect(await screen.findByLabelText('Ada')).toHaveTextContent('A');
  });

  it('never shows the placeholder sign-in name owner', () => {
    const { container } = render(
      <CurrentUserProvider currentUser={{ displayName: 'owner' }}>
        <UserAvatar />
      </CurrentUserProvider>,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
