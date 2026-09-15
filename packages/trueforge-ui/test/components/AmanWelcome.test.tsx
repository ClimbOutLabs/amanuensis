import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AmanSetupProvider, type AmanSetupState } from '@/components/AmanSetupContext.js';
import { AmanWelcome, amanSetupItems, amanWelcomeHeading } from '@/components/AmanWelcome.js';
import { EMPTY_PERSONALIZATION_PROFILE, PersonalizationProvider } from '@/components/PersonalizationContext.js';

function renderWelcome(input: { assistantName?: string | null; setup?: AmanSetupState; heading?: string }) {
  const api = {
    getProfile: async () => ({ ...EMPTY_PERSONALIZATION_PROFILE, assistant_name: input.assistantName ?? null }),
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

  it('lists what is still unset with links to settings, and nothing once setup is complete', () => {
    const { unmount } = renderWelcome({
      setup: { modelName: null, memoryBank: null, settingsHref: '/settings' },
    });
    const list = screen.getByRole('list', { name: 'Finish setting up' });
    expect(list).toHaveTextContent('No model chosen yet.');
    expect(list).toHaveTextContent('Memory is off');
    expect(screen.getByRole('link', { name: 'Choose a model in Settings › Models' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(screen.getByRole('link', { name: 'Connect a memory bank in Settings › Memory' })).toHaveAttribute(
      'href',
      '/settings',
    );
    unmount();

    renderWelcome({ setup: { modelName: 'local-model', memoryBank: { name: 'amantest', connected: true } } });
    expect(screen.queryByRole('list', { name: 'Finish setting up' })).not.toBeInTheDocument();
  });

  it('asks for sign-in when the bank is configured but unreachable for this user', () => {
    const items = amanSetupItems({ modelName: 'local-model', memoryBank: { name: 'amantest', connected: false } });
    expect(items.map(item => item.key)).toEqual(['memory']);
    expect(items[0]?.text).toContain('amantest needs sign-in');
    expect(items[0]?.action).toBe('Sign in under Settings › Memory');
  });

  it('says nothing about memory when the host could not find out', () => {
    expect(amanSetupItems({ modelName: 'local-model', memoryBank: undefined })).toEqual([]);
    expect(amanSetupItems({ modelName: '', memoryBank: undefined }).map(item => item.key)).toEqual(['model']);
  });

  it('renders the plain screen outside a setup provider', () => {
    renderWelcome({ assistantName: null });

    expect(screen.queryByTestId('aman-setup-checklist')).not.toBeInTheDocument();
  });

  it('trims the name before greeting with it', () => {
    expect(amanWelcomeHeading('  Mira ')).toBe("Hi, I'm Mira. What's on your mind?");
    expect(amanWelcomeHeading('   ')).toBe('How can I help you today?');
  });
});
