// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SpacesButton } from '@/atoms/SpacesButton.js';
import { ShellModeProvider, useShellMode } from '@/server/ShellModeContext.js';
import { SpaceProvider, type Space, type SpaceStore } from '@/server/SpaceContext.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { noSpaceFolders } from '../server/noSpaceFolders.js';

const SPAIN_HOUSES: Space = {
  id: 's-spain-houses',
  name: 'Spain houses',
  purpose: 'Track candidate houses in Spain: price, location, and viewing status.',
  status: 'active',
  body: '| Address | Price | Status |\n| --- | --- | --- |\n| Calle Mayor 1 | 250000 | Viewed |',
  format: 'markdown',
  folder_id: null,
  revision: 2,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-10T00:00:00.000Z',
};

function mockStore(spaces: Space[] = [SPAIN_HOUSES]): SpaceStore {
  return {
    list: vi.fn(async () => spaces),
    get: vi.fn(async ({ spaceId }) => {
      const found = spaces.find(space => space.id === spaceId);
      if (found === undefined) throw new Error(`Space not found: ${spaceId}`);
      return found;
    }),
    delete: vi.fn(async () => {}),
    ...noSpaceFolders,
  };
}

function StateReadout() {
  const { spacesOpen, selectedSpaceId } = useShellMode();
  return (
    <p data-testid="shell-state">
      {spacesOpen ? 'open' : 'closed'}:{selectedSpaceId ?? 'list'}
    </p>
  );
}

function renderButton(store: SpaceStore) {
  return render(
    <SlotsProvider>
      <ShellModeProvider>
        <SpaceProvider store={store}>
          <SpacesButton />
          <StateReadout />
        </SpaceProvider>
      </ShellModeProvider>
    </SlotsProvider>,
  );
}

describe('SpacesButton', () => {
  it('shows the space count once loaded', async () => {
    renderButton(mockStore());
    expect(await screen.findByRole('button', { name: /Spaces \(1\)/ })).toBeInTheDocument();
  });

  it('navigates to the spaces list on click instead of opening a modal', async () => {
    renderButton(mockStore());

    fireEvent.click(await screen.findByRole('button', { name: /Spaces/ }));

    await waitFor(() => expect(screen.getByTestId('shell-state')).toHaveTextContent('open:list'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders nothing when no space store is configured', () => {
    render(
      <SlotsProvider>
        <ShellModeProvider>
          <SpacesButton />
        </ShellModeProvider>
      </SlotsProvider>,
    );

    expect(screen.queryByRole('button', { name: /Spaces/ })).not.toBeInTheDocument();
  });

  it('marks the button current when the spaces view is open', async () => {
    renderButton(mockStore());

    const button = await screen.findByRole('button', { name: /Spaces/ });
    expect(button).not.toHaveAttribute('aria-current');

    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveAttribute('aria-current', 'page'));
  });

  it('renders disabled with an explanatory title when mounted without a ShellModeProvider', async () => {
    render(
      <SlotsProvider>
        <SpaceProvider store={mockStore()}>
          <SpacesButton />
        </SpaceProvider>
      </SlotsProvider>,
    );

    const button = await screen.findByRole('button', { name: /Spaces/ });
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toContain('ShellModeProvider');
  });

  it('displays a visible Spaces label when compact=true', async () => {
    render(
      <SlotsProvider>
        <ShellModeProvider>
          <SpaceProvider store={mockStore([SPAIN_HOUSES])}>
            <SpacesButton compact={true} />
          </SpaceProvider>
        </ShellModeProvider>
      </SlotsProvider>,
    );

    const button = await screen.findByRole('button', { name: 'Spaces' });
    const label = button.querySelector('span.text-center');

    expect(label).toBeInTheDocument();
    expect(label).toHaveTextContent('Spaces');
  });
});
