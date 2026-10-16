import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AmanFirstRunGuide, amanFirstRunItems, isFirstRunGuideVisible } from '@/components/AmanFirstRunGuide.js';
import { AmanSetupProvider, type AmanSetupState } from '@/components/AmanSetupContext.js';
import { EMPTY_PERSONALIZATION_PROFILE, PersonalizationProvider } from '@/components/PersonalizationContext.js';

function renderGuide(input: { setup: AmanSetupState; userName?: string | null; placement?: 'chat' | 'settings' }) {
  const api = {
    getProfile: async () => ({ ...EMPTY_PERSONALIZATION_PROFILE, user_name: input.userName ?? null }),
    updateProfile: async () => ({ ...EMPTY_PERSONALIZATION_PROFILE }),
    deleteProfile: async () => {},
  };
  return render(
    <PersonalizationProvider api={api}>
      <AmanSetupProvider value={input.setup}>
        <AmanFirstRunGuide placement={input.placement ?? 'chat'} />
      </AmanSetupProvider>
    </PersonalizationProvider>,
  );
}

describe('amanFirstRunItems', () => {
  it('ticks each line from real state', () => {
    const fresh = amanFirstRunItems({
      modelName: null,
      userName: null,
      hasChatted: false,
      memoryBank: null,
      placement: 'chat',
    });
    expect(fresh.map(item => [item.key, item.done])).toEqual([
      ['model', false],
      ['about-you', false],
      ['first-chat', false],
      ['memory', false],
    ]);

    const halfDone = amanFirstRunItems({
      modelName: 'local/llama',
      userName: 'Sam Rivera',
      hasChatted: false,
      memoryBank: null,
      placement: 'chat',
    });
    expect(halfDone.map(item => item.done)).toEqual([true, true, false, false]);
    expect(halfDone[0]?.detail).toBe('Using local/llama.');
    expect(halfDone[1]?.detail).toBe('Aman knows you as Sam Rivera.');

    const done = amanFirstRunItems({
      modelName: 'local/llama',
      userName: 'Sam',
      hasChatted: true,
      memoryBank: { name: 'amantest', connected: true },
      placement: 'chat',
    });
    expect(done.every(item => item.done)).toBe(true);
  });

  it('leaves out what the host could not find out, and treats a blank name as unset', () => {
    const items = amanFirstRunItems({
      modelName: '  ',
      userName: '   ',
      hasChatted: undefined,
      memoryBank: undefined,
      placement: 'chat',
    });
    expect(items.map(item => item.key)).toEqual(['model', 'about-you']);
    expect(items.every(item => !item.done)).toBe(true);
  });

  it('offers a way back to chat only from settings, and asks for sign-in on an unreachable bank', () => {
    const inChat = amanFirstRunItems({
      modelName: 'm',
      userName: null,
      hasChatted: false,
      memoryBank: { name: 'amantest', connected: false },
      placement: 'chat',
    });
    expect(inChat.find(item => item.key === 'first-chat')?.action).toBeUndefined();
    expect(inChat.find(item => item.key === 'memory')).toMatchObject({
      done: false,
      detail: 'amantest needs sign-in before it can recall anything.',
      action: { label: 'Sign in', target: { kind: 'settings', section: 'memory' } },
    });

    const inSettings = amanFirstRunItems({
      modelName: 'm',
      userName: null,
      hasChatted: false,
      memoryBank: undefined,
      placement: 'settings',
    });
    expect(inSettings.find(item => item.key === 'first-chat')?.action).toEqual({
      label: 'Back to chat',
      target: { kind: 'chat' },
    });
  });
});

describe('AmanFirstRunGuide', () => {
  it('shows progress, links the open lines to settings, and dismisses through the host', async () => {
    const dismiss = vi.fn();
    renderGuide({
      userName: 'Sam',
      setup: {
        modelName: 'local/llama',
        memoryBank: undefined,
        hasChatted: false,
        firstRunGuide: { dismissed: false, dismiss },
        settingsHref: '/settings',
      },
    });

    expect(await screen.findByRole('heading', { name: 'Welcome to Aman' })).toBeInTheDocument();
    expect(screen.getByTestId('aman-first-run-progress')).toHaveTextContent('2 of 3 done.');
    const items = screen.getAllByRole('listitem');
    expect(items.map(item => item.getAttribute('data-done'))).toEqual(['true', 'true', 'false']);
    expect(items[1]).toHaveTextContent('Done: Tell Aman about you');
    // Done lines carry no link; there is nothing left to do there.
    expect(screen.queryByRole('link', { name: 'Open Personalization' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('says so when everything is done, and renders nothing once dismissed', async () => {
    const { unmount } = renderGuide({
      userName: 'Sam',
      setup: {
        modelName: 'local/llama',
        memoryBank: { name: 'amantest', connected: true },
        hasChatted: true,
        firstRunGuide: { dismissed: false, dismiss: () => {} },
      },
    });
    expect(await screen.findByRole('heading', { name: 'You are all set' })).toBeInTheDocument();
    unmount();

    renderGuide({
      setup: { modelName: null, memoryBank: null, firstRunGuide: { dismissed: true, dismiss: () => {} } },
    });
    expect(screen.queryByTestId('aman-first-run-guide')).not.toBeInTheDocument();
  });

  it('has no dismiss control when the host cannot remember one', async () => {
    renderGuide({ setup: { modelName: null, memoryBank: undefined, settingsHref: '/settings' } });
    expect(await screen.findByRole('heading', { name: 'Welcome to Aman' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Personalization' })).toHaveAttribute('href', '/settings');
  });

  it('is visible until the host reports a dismissal', () => {
    expect(isFirstRunGuideVisible(null)).toBe(false);
    expect(isFirstRunGuideVisible({ modelName: null, memoryBank: undefined })).toBe(true);
    expect(
      isFirstRunGuideVisible({
        modelName: null,
        memoryBank: undefined,
        firstRunGuide: { dismissed: false, dismiss() {} },
      }),
    ).toBe(true);
    expect(
      isFirstRunGuideVisible({
        modelName: null,
        memoryBank: undefined,
        firstRunGuide: { dismissed: true, dismiss() {} },
      }),
    ).toBe(false);
  });
});
