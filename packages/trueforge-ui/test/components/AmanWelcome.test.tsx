import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AmanSetupProvider, type AmanSetupState } from '@/components/AmanSetupContext.js';
import { AmanWelcome, amanWelcomeHeading } from '@/components/AmanWelcome.js';
import { EMPTY_PERSONALIZATION_PROFILE, PersonalizationProvider } from '@/components/PersonalizationContext.js';

function renderWelcome(input: {
  assistantName?: string | null;
  userName?: string | null;
  setup?: AmanSetupState;
  heading?: string;
}) {
  const api = {
    getProfile: async () => ({
      ...EMPTY_PERSONALIZATION_PROFILE,
      assistant_name: input.assistantName ?? null,
      user_name: input.userName ?? null,
    }),
    updateProfile: async () => ({ ...EMPTY_PERSONALIZATION_PROFILE }),
    deleteProfile: async () => {},
  };
  const screenElement = <AmanWelcome heading={input.heading} />;
  return render(
    <PersonalizationProvider api={api}>
      {input.setup === undefined ? (
        screenElement
      ) : (
        <AmanSetupProvider value={input.setup}>{screenElement}</AmanSetupProvider>
      )}
    </PersonalizationProvider>,
  );
}

const dismissed = { dismissed: true, dismiss: () => {} };

describe('AmanWelcome', () => {
  it("greets in the assistant's name once the profile carries one", async () => {
    renderWelcome({ assistantName: 'Testinatrix' });

    expect(
      await screen.findByRole('heading', { level: 1, name: "Hi, I'm Testinatrix. What's on your mind?" }),
    ).toBeInTheDocument();
  });

  it('falls back to the plain greeting without a name', async () => {
    renderWelcome({ assistantName: null });

    expect(await screen.findByRole('heading', { level: 1, name: 'How can I help you today?' })).toBeInTheDocument();
  });

  it('keeps a heading the runtime passes in, such as an active agent name', async () => {
    renderWelcome({ assistantName: 'Testinatrix', heading: 'Repo Reviewer' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Repo Reviewer' })).toBeInTheDocument();
  });

  it('shows the first-run checklist with links to settings until it is dismissed', async () => {
    renderWelcome({
      setup: { modelName: null, hasChatted: false, settingsHref: '/settings' },
    });
    const list = await screen.findByRole('list', { name: 'Setup checklist' });
    expect(list).toHaveTextContent('Add a model');
    expect(list).toHaveTextContent('Tell Aman about you');
    expect(list).toHaveTextContent('Try your first chat');
    expect(screen.getByRole('link', { name: 'Choose a model' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: 'Open Personalization' })).toHaveAttribute('href', '/settings');
    expect(screen.queryByTestId('aman-name-prompt')).not.toBeInTheDocument();
  });

  it('after dismissal, shows one quiet line about the name only while it is unset', async () => {
    const { unmount } = renderWelcome({
      userName: null,
      setup: { modelName: 'local-model', firstRunGuide: dismissed, settingsHref: '/settings' },
    });
    const prompt = await screen.findByTestId('aman-name-prompt');
    expect(prompt).toHaveTextContent('Aman does not know your name yet.');
    expect(screen.getByRole('link', { name: 'Add it in Personalization' })).toHaveAttribute('href', '/settings');
    expect(screen.queryByTestId('aman-first-run-guide')).not.toBeInTheDocument();
    unmount();

    renderWelcome({
      userName: 'Sam',
      setup: { modelName: 'local-model', firstRunGuide: dismissed },
    });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId('aman-name-prompt')).not.toBeInTheDocument();
    expect(screen.queryByTestId('aman-first-run-guide')).not.toBeInTheDocument();
  });

  it('renders the plain screen outside a setup provider', async () => {
    renderWelcome({ assistantName: null });

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId('aman-first-run-guide')).not.toBeInTheDocument();
    expect(screen.queryByTestId('aman-name-prompt')).not.toBeInTheDocument();
  });

  it('builds the heading from a trimmed name', () => {
    expect(amanWelcomeHeading('  Mira ')).toBe("Hi, I'm Mira. What's on your mind?");
    expect(amanWelcomeHeading('')).toBe('How can I help you today?');
    expect(amanWelcomeHeading(undefined)).toBe('How can I help you today?');
  });
});
