// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AmanRuntimeRail } from '@/components/AmanRuntimeRail.js';
import { PersonalizationProvider, type PersonalizationProfile } from '@/components/PersonalizationContext.js';
import { PersonalizationPanel } from '@/components/PersonalizationPanel.js';

const initialProfile: PersonalizationProfile = {
  assistant_name: 'Mira',
  assistant_identity: 'A thoughtful local assistant.',
  voice_guidance: 'Warm and direct.',
  user_name: null,
  address_as: null,
  user_profile: 'Values privacy.',
  pinned_preferences: ['Use short summaries.'],
  help_areas: [],
  learned_profile: null,
  learning_enabled: false,
};

describe('PersonalizationPanel', () => {
  it('asks for the name and form of address first and saves them', async () => {
    const updateProfile = vi.fn(async profile => ({ ...profile }));
    render(
      <PersonalizationProvider
        api={{
          getProfile: async () => null,
          updateProfile,
          deleteProfile: async () => {},
        }}
      >
        <PersonalizationPanel />
      </PersonalizationProvider>,
    );

    const nameField = await screen.findByLabelText('Your name');
    const addressField = screen.getByLabelText('How Aman should address you');
    const [firstSection] = screen.getAllByRole('region');
    expect(firstSection).toHaveAccessibleName('About you');
    expect(firstSection).toContainElement(nameField);
    expect(firstSection).toContainElement(addressField);
    // The name fields come before everything else on the page, including the assistant's own profile.
    expect(nameField.compareDocumentPosition(screen.getByLabelText('Name'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.change(nameField, { target: { value: 'Sam Rivera' } });
    fireEvent.change(addressField, { target: { value: 'Sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save personalization' }));

    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({ user_name: 'Sam Rivera', address_as: 'Sam' }),
      ),
    );
  });

  it('loads and saves the profile from Settings while updating the runtime identity', async () => {
    const updateProfile = vi.fn(async profile => ({ ...profile }));
    render(
      <PersonalizationProvider
        api={{
          getProfile: async () => initialProfile,
          updateProfile,
          deleteProfile: async () => {},
        }}
      >
        <PersonalizationPanel />
        <AmanRuntimeRail />
      </PersonalizationProvider>,
    );

    expect(await screen.findByDisplayValue('Mira')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Mira' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sage' } });
    fireEvent.change(screen.getByLabelText('Pinned preference 1'), { target: { value: 'No em dashes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save personalization' }));

    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({ assistant_name: 'Sage', pinned_preferences: ['No em dashes.'] }),
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Personalization saved.');
    expect(screen.getByRole('heading', { name: 'Sage' })).toBeInTheDocument();
  });

  it('keeps focus and accumulates every character typed into a new pinned preference', async () => {
    // Regression test: a row keyed by its own (changing) text remounts the <input> on every
    // keystroke, which drops focus after the first character. Simulate real typing —
    // one `change` per keystroke, each carrying the accumulated value, the way a browser fires
    // them — and assert the row's DOM node never changes underneath the user.
    //
    // Also covers the second way rows used to remount: the profile-sync effect used to depend on
    // `onProfileChange`, so a host that supplies it inline (a fresh function identity on every one
    // of its own renders, unrelated to the profile) would regenerate every row id and remount the
    // inputs. `Host` re-renders mid-typing with a new `onProfileChange` each time, and the profile
    // itself never changes, so the row must survive that too.
    const updateProfile = vi.fn(async (profile: PersonalizationProfile) => ({ ...profile }));
    // Held stable across `Host` re-renders (unlike `onProfileChange` below) so the only thing
    // varying is the callback identity, isolating what this test is regression-covering.
    const api = {
      getProfile: async () => ({ ...initialProfile, pinned_preferences: [] }),
      updateProfile,
      deleteProfile: async () => {},
    };

    function Host() {
      const [, forceRerender] = useState(0);
      return (
        <PersonalizationProvider api={api}>
          <PersonalizationPanel onProfileChange={() => {}} />
          <button type="button" onClick={() => forceRerender(current => current + 1)}>
            Re-render host
          </button>
        </PersonalizationProvider>
      );
    }

    render(<Host />);

    await screen.findByDisplayValue('Mira');
    fireEvent.click(screen.getByRole('button', { name: '+ Add preference' }));

    const input = screen.getByLabelText('Pinned preference 1');
    const text = 'Prefers metric units';
    for (let typed = 1; typed <= text.length; typed += 1) {
      fireEvent.change(screen.getByLabelText('Pinned preference 1'), { target: { value: text.slice(0, typed) } });
      // A stable row key keeps this the same element across keystrokes; an index/value-derived
      // key remounts the row here, handing back a brand-new (unfocused) input.
      expect(screen.getByLabelText('Pinned preference 1')).toBe(input);

      if (typed === Math.floor(text.length / 2)) {
        fireEvent.click(screen.getByRole('button', { name: 'Re-render host' }));
        // Same check, now after a parent render that only changed the callback's identity.
        expect(screen.getByLabelText('Pinned preference 1')).toBe(input);
      }
    }

    expect(input).toHaveValue(text);
  });

  it('shows no help-area picker in Settings and keeps the help areas already saved', async () => {
    // The "What would help you most?" picker lives on the New Chat home, not in Settings.
    // Areas a person already picked stay on their profile: a Settings save carries them
    // through unchanged rather than dropping them with the removed section.
    const updateProfile = vi.fn(async (profile: PersonalizationProfile) => ({ ...profile }));
    render(
      <PersonalizationProvider
        api={{
          getProfile: async () => ({ ...initialProfile, help_areas: ['new_country', 'family'] }),
          updateProfile,
          deleteProfile: async () => {},
        }}
      >
        <PersonalizationPanel />
      </PersonalizationProvider>,
    );

    await screen.findByDisplayValue('Mira');
    expect(screen.queryByText('What would help you most?')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'I just moved here' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Someone I look after' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save personalization' }));

    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({ assistant_name: 'Sage', help_areas: ['new_country', 'family'] }),
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Personalization saved.');
  });

  it('clears the persisted profile and resets the form', async () => {
    const deleteProfile = vi.fn(async () => {});
    render(
      <PersonalizationProvider
        api={{
          getProfile: async () => initialProfile,
          updateProfile: async profile => profile,
          deleteProfile,
        }}
      >
        <PersonalizationPanel />
      </PersonalizationProvider>,
    );

    expect(await screen.findByDisplayValue('Mira')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    await waitFor(() => expect(deleteProfile).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('Personalization cleared.');
  });

  it('clears only this page and keeps the learned profile, its switch and the help areas', async () => {
    // The learned profile lives on Settings > Memory now, out of sight from this page, so
    // Clear all here must not delete it or turn learning off.
    const learned: PersonalizationProfile = {
      ...initialProfile,
      user_name: 'Sam Rivera',
      help_areas: ['family'],
      learned_profile: '# Learned\n\n- Enjoys woodworking.',
      learning_enabled: true,
    };
    const deleteProfile = vi.fn(async () => {});
    const updateProfile = vi.fn(async (profile: PersonalizationProfile) => profile);
    render(
      <PersonalizationProvider api={{ getProfile: async () => learned, updateProfile, deleteProfile }}>
        <PersonalizationPanel />
      </PersonalizationProvider>,
    );

    expect(await screen.findByDisplayValue('Sam Rivera')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    expect(deleteProfile).not.toHaveBeenCalled();
    expect(updateProfile.mock.calls[0]?.[0]).toEqual({
      assistant_name: null,
      assistant_identity: null,
      voice_guidance: null,
      user_name: null,
      address_as: null,
      user_profile: null,
      pinned_preferences: [],
      help_areas: ['family'],
      learned_profile: '# Learned\n\n- Enjoys woodworking.',
      learning_enabled: true,
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Personalization cleared.');
    expect(screen.getByLabelText('Your name')).toHaveValue('');
  });

  it('carries the learned profile fields through a save without inventing a learning switch', async () => {
    // The Learned profile block lives under Settings > Memory now; this panel no longer shows
    // it. The fields are still on the profile the panel saves, so they ride through a save
    // unchanged, like the help areas. And a host predating the toggle sends no switch: sending
    // an invented key back would be rejected by a host that does not know it, and would fail
    // every save the user makes.
    const withoutSwitch: PersonalizationProfile = {
      assistant_name: 'Mira',
      assistant_identity: null,
      voice_guidance: null,
      user_name: null,
      address_as: null,
      user_profile: null,
      pinned_preferences: [],
      help_areas: [],
      learned_profile: '# Learned\n\n- Enjoys woodworking.',
    };
    const updateProfile = vi.fn(async (profile: PersonalizationProfile) => ({ ...profile }));
    render(
      <PersonalizationProvider
        api={{ getProfile: async () => withoutSwitch, updateProfile, deleteProfile: async () => {} }}
      >
        <PersonalizationPanel />
      </PersonalizationProvider>,
    );

    await screen.findByDisplayValue('Mira');
    expect(screen.queryByRole('heading', { name: 'Learned profile' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Learn from conversations' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save personalization' }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    expect(updateProfile.mock.calls[0]?.[0]).not.toHaveProperty('learning_enabled');
    expect(updateProfile.mock.calls[0]?.[0]).toHaveProperty('learned_profile', '# Learned\n\n- Enjoys woodworking.');
    expect(await screen.findByRole('status')).toHaveTextContent('Personalization saved.');
  });
});
