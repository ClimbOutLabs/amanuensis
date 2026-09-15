// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SpaceProvider, useOptionalSpaces, type Space, type SpaceStore } from '@/server/SpaceContext.js';

const SPAIN_HOUSES: Space = {
  id: 's-spain-houses',
  name: 'Spain houses',
  purpose: 'Track candidate houses in Spain.',
  status: 'active',
  body: 'Shortlist.',
  format: 'markdown',
  revision: 1,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
};

function Probe() {
  const ctx = useOptionalSpaces();
  if (ctx == null) return <p data-testid="probe">no-store</p>;
  return (
    <div>
      <p data-testid="probe">
        {ctx.loading ? 'loading' : 'idle'}:{ctx.spaces.length}
      </p>
      <button type="button" onClick={() => ctx.refresh()}>
        Refresh
      </button>
    </div>
  );
}

function deferredList(): { list: () => Promise<Space[]>; resolve: (spaces: Space[]) => void } {
  let resolveList: ((spaces: Space[]) => void) | undefined;
  return {
    list: () =>
      new Promise<Space[]>(resolve => {
        resolveList = resolve;
      }),
    resolve: spaces => resolveList?.(spaces),
  };
}

function readProbe() {
  return screen.getByTestId('probe').textContent;
}

describe('SpaceProvider loading state', () => {
  it('shows loading while the first fetch, starting from an empty list, is in flight', async () => {
    const { list, resolve } = deferredList();
    const store: SpaceStore = { list, get: async () => SPAIN_HOUSES, delete: async () => {} };

    render(
      <SpaceProvider store={store}>
        <Probe />
      </SpaceProvider>,
    );

    await waitFor(() => expect(readProbe()).toBe('loading:0'));

    act(() => resolve([SPAIN_HOUSES]));

    await waitFor(() => expect(readProbe()).toBe('idle:1'));
  });

  it('does not flash loading on a refresh behind an already-populated list, even when the refresh empties it', async () => {
    const list = vi.fn();
    let resolveFirst: ((spaces: Space[]) => void) | undefined;
    let resolveSecond: ((spaces: Space[]) => void) | undefined;
    list
      .mockImplementationOnce(() => new Promise<Space[]>(resolve => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise<Space[]>(resolve => (resolveSecond = resolve)));
    const store: SpaceStore = { list, get: async () => SPAIN_HOUSES, delete: async () => {} };

    render(
      <SpaceProvider store={store}>
        <Probe />
      </SpaceProvider>,
    );

    await waitFor(() => expect(readProbe()).toBe('loading:0'));
    act(() => resolveFirst?.([SPAIN_HOUSES]));
    await waitFor(() => expect(readProbe()).toBe('idle:1'));

    // Refresh while the list is already populated: a request is in flight, but nothing should
    // flash to a loading state while there is still a populated list to show.
    act(() => screen.getByRole('button', { name: 'Refresh' }).click());
    expect(readProbe()).toBe('idle:1');

    // The refresh comes back empty (the last space was deleted elsewhere). The transition should
    // land cleanly on the empty list with no loading state stuck on.
    act(() => resolveSecond?.([]));
    await waitFor(() => expect(readProbe()).toBe('idle:0'));
  });

  it('shows loading again on a fetch that starts once the list has already gone empty', async () => {
    const list = vi.fn();
    let resolveFirst: ((spaces: Space[]) => void) | undefined;
    let resolveSecond: ((spaces: Space[]) => void) | undefined;
    let resolveThird: ((spaces: Space[]) => void) | undefined;
    list
      .mockImplementationOnce(() => new Promise<Space[]>(resolve => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise<Space[]>(resolve => (resolveSecond = resolve)))
      .mockImplementationOnce(() => new Promise<Space[]>(resolve => (resolveThird = resolve)));
    const store: SpaceStore = { list, get: async () => SPAIN_HOUSES, delete: async () => {} };

    render(
      <SpaceProvider store={store}>
        <Probe />
      </SpaceProvider>,
    );

    // First load: populated.
    await waitFor(() => expect(readProbe()).toBe('loading:0'));
    act(() => resolveFirst?.([SPAIN_HOUSES]));
    await waitFor(() => expect(readProbe()).toBe('idle:1'));

    // Second load: populated to empty, no flash while it was still populated going in.
    act(() => screen.getByRole('button', { name: 'Refresh' }).click());
    expect(readProbe()).toBe('idle:1');
    act(() => resolveSecond?.([]));
    await waitFor(() => expect(readProbe()).toBe('idle:0'));

    // Third load: starts from an already-empty list, so there is nothing to show while it is in
    // flight. A sticky "has ever had spaces" flag would still read true from the first load here
    // and wrongly keep the loading state suppressed; the fix derives it from the current list.
    act(() => screen.getByRole('button', { name: 'Refresh' }).click());
    await waitFor(() => expect(readProbe()).toBe('loading:0'));

    act(() => resolveThird?.([SPAIN_HOUSES]));
    await waitFor(() => expect(readProbe()).toBe('idle:1'));
  });

  it('shows loading on the next fetch after the store becomes unavailable and then available again with an empty list', async () => {
    const { list: firstList, resolve: resolveFirst } = deferredList();
    const store: SpaceStore = { list: firstList, get: async () => SPAIN_HOUSES, delete: async () => {} };

    const { rerender } = render(
      <SpaceProvider store={store}>
        <Probe />
      </SpaceProvider>,
    );

    await waitFor(() => expect(readProbe()).toBe('loading:0'));
    act(() => resolveFirst([SPAIN_HOUSES]));
    await waitFor(() => expect(readProbe()).toBe('idle:1'));

    // The store goes away (e.g. the host disables the feature): the list clears.
    rerender(
      <SpaceProvider store={undefined}>
        <Probe />
      </SpaceProvider>,
    );
    expect(readProbe()).toBe('no-store');

    // The store comes back. Spaces are empty at this point, so the next fetch should show
    // loading rather than silently skip it because of a flag left over from the first fetch.
    const { list: secondList, resolve: resolveSecond } = deferredList();
    const secondStore: SpaceStore = { list: secondList, get: async () => SPAIN_HOUSES, delete: async () => {} };
    rerender(
      <SpaceProvider store={secondStore}>
        <Probe />
      </SpaceProvider>,
    );
    await waitFor(() => expect(readProbe()).toBe('loading:0'));

    act(() => resolveSecond([]));
    await waitFor(() => expect(readProbe()).toBe('idle:0'));
  });
});

function DeleteProbe({ spaceId }: { spaceId: string }) {
  const ctx = useOptionalSpaces();
  if (ctx == null) return null;
  return (
    <div>
      <p data-testid="probe">{ctx.spaces.length}</p>
      <button type="button" onClick={() => void ctx.deleteSpace({ spaceId, expectedRevision: 1 })}>
        Delete
      </button>
    </div>
  );
}

describe('SpaceProvider deleteSpace', () => {
  it('calls the store with the given revision, then refreshes the list', async () => {
    const deleteFn = vi.fn(async () => {});
    const list = vi
      .fn<() => Promise<Space[]>>()
      .mockImplementationOnce(async () => [SPAIN_HOUSES])
      .mockImplementationOnce(async () => []);
    const store: SpaceStore = { list, get: async () => SPAIN_HOUSES, delete: deleteFn };

    render(
      <SpaceProvider store={store}>
        <DeleteProbe spaceId={SPAIN_HOUSES.id} />
      </SpaceProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('1'));

    act(() => screen.getByRole('button', { name: 'Delete' }).click());

    await waitFor(() => expect(deleteFn).toHaveBeenCalledWith({ spaceId: SPAIN_HOUSES.id, expectedRevision: 1 }));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('0'));
    expect(list).toHaveBeenCalledTimes(2);
  });
});
