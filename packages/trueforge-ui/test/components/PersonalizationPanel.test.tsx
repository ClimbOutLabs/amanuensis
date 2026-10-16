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
    expect(nameField.compareDocumentPosition(screen.getByLabelText('Assistant name'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

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

    fireEvent.change(screen.getByLabelText('Assistant name'), { target: { value: 'Sage' } });
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

  it('edits and clears the learned profile through the ordinary save flow', async () => {
    const updateProfile = vi.fn(async (profile: PersonalizationProfile) => ({ ...profile }));
    render(
      <PersonalizationProvider
        api={{
          getProfile: async () => ({ ...initialProfile, learned_profile: '# Learned\n\n- Enjoys woodworking.' }),
          updateProfile,
          deleteProfile: async () => {},
        }}
      >
        <PersonalizationPanel />
      </PersonalizationProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Learned profile' })).toBeInTheDocument();
    // Rendered as markdown until the user chooses to edit. The heading is not gated on the
    // loaded profile, so the document body has to be awaited separately.
    expect(await screen.findByText('Enjoys woodworking.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Learned profile document'), {
      target: { value: '# Learned\n\n- Prefers plain English.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save personalization' }));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({ learned_profile: '# Learned\n\n- Prefers plain English.' }),
      ),
    );
    // Wait for the save round-trip to settle before mutating the draft again:
    // the provider refresh resets the draft when the saved profile arrives.
    expect(await screen.findByRole('status')).toHaveTextContent('Personalization saved.');

    fireEvent.click(screen.getByRole('button', { name: 'Clear learned profile' }));
    expect(screen.getByText('Nothing learned yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save personalization' }));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenLastCalledWith(expect.objectContaining({ learned_profile: null })),
    );
  });

  it('reflects the stored learning switch and says what turning it on does', async () => {
    render(
      <PersonalizationProvider
        api={{
          getProfile: async () => ({ ...initialProfile, learning_enabled: true }),
          updateProfile: async profile => profile,
          deleteProfile: async () => {},
        }}
      >
        <PersonalizationPanel />
      </PersonalizationProvider>,
    );

    const toggle = await screen.findByRole('switch', { name: 'Learn from conversations' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText(/asks a local model to rewrite this document/)).toBeInTheDocument();
    expect(screen.getByText(/at most once an hour/)).toBeInTheDocument();
  });

  it('persists the learning switch through the ordinary save flow', async () => {
    const updateProfile = vi.fn(async (profile: PersonalizationProfile) => ({ ...profile }));
    render(
      <PersonalizationProvider
        api={{ getProfile: async () => initialProfile, updateProfile, deleteProfile: async () => {} }}
      >
        <PersonalizationPanel />
      </PersonalizationProvider>,
    );

    await screen.findByDisplayValue('Mira');
    const toggle = await screen.findByRole('switch', { name: 'Learn from conversations' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save personalization' }));

    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({ learning_enabled: true })),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Personalization saved.');

    fireEvent.click(screen.getByRole('switch', { name: 'Learn from conversations' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save personalization' }));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenLastCalledWith(expect.objectContaining({ learning_enabled: false })),
    );
  });

  it('turns the switch back off on a profile that holds nothing else', async () => {
    // Trying the feature and changing your mind is a common path for a new toggle, and it is
    // the one case where the saved profile carries no content but the switch. The panel must
    // send the switch explicitly: the server tells an explicit "off" from an omitted key, and
    // only the latter is the empty request that DELETE is for.
    const onlyLearning: PersonalizationProfile = {
      assistant_name: null,
      assistant_identity: null,
      voice_guidance: null,
      user_name: null,
      address_as: null,
      user_profile: null,
      pinned_preferences: [],
      learned_profile: null,
      learning_enabled: true,
    };
    const updateProfile = vi.fn(async (profile: PersonalizationProfile) => ({ ...profile }));
    render(
      <PersonalizationProvider
        api={{ getProfile: async () => onlyLearning, updateProfile, deleteProfile: async () => {} }}
      >
        <PersonalizationPanel />
      </PersonalizationProvider>,
    );

    const toggle = await screen.findByRole('switch', { name: 'Learn from conversations' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save personalization' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ ...onlyLearning, learning_enabled: false }));
    expect(await screen.findByRole('status')).toHaveTextContent('Personalization saved.');
    expect(screen.getByRole('switch', { name: 'Learn from conversations' })).toHaveAttribute('aria-checked', 'false');
  });

  it('surfaces the panel error affordance when saving the switch fails', async () => {
    const updateProfile = vi.fn(async () => {
      throw new Error('Learning could not be turned on.');
    });
    render(
      <PersonalizationProvider
        api={{ getProfile: async () => initialProfile, updateProfile, deleteProfile: async () => {} }}
      >
        <PersonalizationPanel />
      </PersonalizationProvider>,
    );

    await screen.findByDisplayValue('Mira');
    fireEvent.click(screen.getByRole('switch', { name: 'Learn from conversations' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save personalization' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Learning could not be turned on.');
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
    expect(screen.getByLabelText('Assistant name')).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('Personalization cleared.');
  });

  it('renders a profile that carries no learning switch as off without inventing one', async () => {
    // A host predating the toggle sends no switch. The panel needs a boolean to render, but the
    // rendering default stays out of the profile: sending an invented key back would be rejected
    // by a host that does not know it, and would fail every save the user makes.
    const withoutSwitch: PersonalizationProfile = {
      assistant_name: 'Mira',
      assistant_identity: null,
      voice_guidance: null,
      user_name: null,
      address_as: null,
      user_profile: null,
      pinned_preferences: [],
      learned_profile: null,
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
    expect(screen.getByRole('switch', { name: 'Learn from conversations' })).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Save personalization' }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    expect(updateProfile.mock.calls[0]?.[0]).not.toHaveProperty('learning_enabled');
    // Let the save round-trip settle before touching the draft: the provider refresh resets it
    // when the saved profile arrives.
    expect(await screen.findByRole('status')).toHaveTextContent('Personalization saved.');

    // Moving the toggle is a choice, and a choice is always sent.
    fireEvent.click(screen.getByRole('switch', { name: 'Learn from conversations' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save personalization' }));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenLastCalledWith(expect.objectContaining({ learning_enabled: true })),
    );
  });
});
