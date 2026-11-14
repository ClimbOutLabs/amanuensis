// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  PersonalizationConflictError,
  PersonalizationProvider,
  type PersonalizationProfile,
} from '@/components/PersonalizationContext.js';
import LearnedProfilePanel from '@/containers/SettingsBuilder/LearnedProfilePanel.js';

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

describe('LearnedProfilePanel', () => {
  it('edits and clears the learned profile through its own save flow', async () => {
    const updateProfile = vi.fn(async (profile: PersonalizationProfile) => ({ ...profile }));
    render(
      <PersonalizationProvider
        api={{
          getProfile: async () => ({ ...initialProfile, learned_profile: '# Learned\n\n- Enjoys woodworking.' }),
          updateProfile,
          deleteProfile: async () => {},
        }}
      >
        <LearnedProfilePanel />
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
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({ learned_profile: '# Learned\n\n- Prefers plain English.' }),
      ),
    );
    // Wait for the save round-trip to settle before mutating the draft again:
    // the provider refresh resets the draft when the saved profile arrives.
    expect(await screen.findByRole('status')).toHaveTextContent('Learned profile saved.');

    fireEvent.click(screen.getByRole('button', { name: 'Clear learned profile' }));
    expect(screen.getByText('Nothing learned yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenLastCalledWith(expect.objectContaining({ learned_profile: null })),
    );
  });

  it("keeps the person's own edit to the learned text when it changed on both sides", async () => {
    const opened: PersonalizationProfile = { ...initialProfile, learned_profile: '- Likes tea.', revision: 1 };
    const getProfile = vi.fn<() => Promise<PersonalizationProfile>>();
    getProfile
      .mockResolvedValueOnce(opened)
      .mockResolvedValue({ ...opened, learned_profile: '- Likes tea.\n- Likes hiking.', revision: 2 });
    const updateProfile = vi.fn(async (profile: PersonalizationProfile) => {
      if (profile.revision !== 2) {
        throw new PersonalizationConflictError('Your profile changed while this page was open.');
      }
      return { ...profile, revision: 3 };
    });
    render(
      <PersonalizationProvider api={{ getProfile, updateProfile, deleteProfile: async () => {} }}>
        <LearnedProfilePanel />
      </PersonalizationProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Learned profile document'), { target: { value: '- Likes coffee.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Learned profile saved.')).toBeInTheDocument();
    expect(updateProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ learned_profile: '- Likes coffee.', revision: 2 }),
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
        <LearnedProfilePanel />
      </PersonalizationProvider>,
    );

    const toggle = await screen.findByRole('switch', { name: 'Learn from conversations' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText(/it adds a line here/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is lost/)).toBeInTheDocument();
  });

  it('persists the learning switch through its own save flow', async () => {
    const updateProfile = vi.fn(async (profile: PersonalizationProfile) => ({ ...profile }));
    render(
      <PersonalizationProvider
        api={{ getProfile: async () => initialProfile, updateProfile, deleteProfile: async () => {} }}
      >
        <LearnedProfilePanel />
      </PersonalizationProvider>,
    );

    const toggle = await screen.findByRole('switch', { name: 'Learn from conversations' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({ learning_enabled: true })),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Learned profile saved.');

    fireEvent.click(screen.getByRole('switch', { name: 'Learn from conversations' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenLastCalledWith(expect.objectContaining({ learning_enabled: false })),
    );
  });

  it('keeps a switch click made the moment the profile finishes loading', async () => {
    // The profile arriving and the click can land in the same instant. The click is the
    // person's choice and must stick; the loaded value must not overwrite it.
    let finishLoad: (profile: PersonalizationProfile) => void = () => {};
    const loaded = new Promise<PersonalizationProfile>(resolve => {
      finishLoad = resolve;
    });
    const { container } = render(
      <PersonalizationProvider
        api={{ getProfile: () => loaded, updateProfile: async profile => profile, deleteProfile: async () => {} }}
      >
        <LearnedProfilePanel />
      </PersonalizationProvider>,
    );
    // Click in the same moment the switch first appears, before anything else can run.
    const clicked = new Promise<void>(done => {
      const observer = new MutationObserver(() => {
        const toggle = container.querySelector('[role="switch"]');
        if (toggle instanceof HTMLElement) {
          observer.disconnect();
          fireEvent.click(toggle);
          done();
        }
      });
      observer.observe(container, { childList: true, subtree: true });
    });

    finishLoad(initialProfile);
    await clicked;

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Learn from conversations' })).toHaveAttribute('aria-checked', 'true'),
    );
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.getByRole('switch', { name: 'Learn from conversations' })).toHaveAttribute('aria-checked', 'true');
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
      help_areas: [],
      learned_profile: null,
      learning_enabled: true,
    };
    const updateProfile = vi.fn(async (profile: PersonalizationProfile) => ({ ...profile }));
    render(
      <PersonalizationProvider
        api={{ getProfile: async () => onlyLearning, updateProfile, deleteProfile: async () => {} }}
      >
        <LearnedProfilePanel />
      </PersonalizationProvider>,
    );

    const toggle = await screen.findByRole('switch', { name: 'Learn from conversations' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ ...onlyLearning, learning_enabled: false }));
    expect(await screen.findByRole('status')).toHaveTextContent('Learned profile saved.');
    expect(screen.getByRole('switch', { name: 'Learn from conversations' })).toHaveAttribute('aria-checked', 'false');
  });

  it('surfaces the error when saving the switch fails', async () => {
    const updateProfile = vi.fn(async () => {
      throw new Error('Learning could not be turned on.');
    });
    render(
      <PersonalizationProvider
        api={{ getProfile: async () => initialProfile, updateProfile, deleteProfile: async () => {} }}
      >
        <LearnedProfilePanel />
      </PersonalizationProvider>,
    );

    await screen.findByRole('switch', { name: 'Learn from conversations' });
    fireEvent.click(screen.getByRole('switch', { name: 'Learn from conversations' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Learning could not be turned on.');
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
      help_areas: [],
      learned_profile: null,
    };
    const updateProfile = vi.fn(async (profile: PersonalizationProfile) => ({ ...profile }));
    render(
      <PersonalizationProvider
        api={{ getProfile: async () => withoutSwitch, updateProfile, deleteProfile: async () => {} }}
      >
        <LearnedProfilePanel />
      </PersonalizationProvider>,
    );

    const toggle = await screen.findByRole('switch', { name: 'Learn from conversations' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    expect(updateProfile.mock.calls[0]?.[0]).not.toHaveProperty('learning_enabled');
    // Let the save round-trip settle before touching the draft: the provider refresh resets it
    // when the saved profile arrives.
    expect(await screen.findByRole('status')).toHaveTextContent('Learned profile saved.');

    // Moving the toggle is a choice, and a choice is always sent.
    fireEvent.click(screen.getByRole('switch', { name: 'Learn from conversations' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenLastCalledWith(expect.objectContaining({ learning_enabled: true })),
    );
  });

  it('leaves every other profile field exactly as loaded when it saves', async () => {
    const updateProfile = vi.fn(async (profile: PersonalizationProfile) => ({ ...profile }));
    render(
      <PersonalizationProvider
        api={{ getProfile: async () => initialProfile, updateProfile, deleteProfile: async () => {} }}
      >
        <LearnedProfilePanel />
      </PersonalizationProvider>,
    );

    await screen.findByRole('switch', { name: 'Learn from conversations' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith(initialProfile));
  });
});
