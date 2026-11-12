// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DeliveriesProvider } from '@/deliveries/DeliveriesContext.js';
import { DeliveryPushLinks } from '@/deliveries/DeliveryPushLinks.js';

import { fakeServer, item } from './fakeDeliveriesApi.js';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('opening the item a tapped notice names', () => {
  it('fetches the details only after the page opens, marks the item seen, and clears the address', async () => {
    window.history.replaceState(null, '', '/?delivery=a');
    const { api } = fakeServer([item({ id: 'a' })]);
    render(
      <DeliveriesProvider api={api}>
        <DeliveryPushLinks />
      </DeliveriesProvider>,
    );

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(api.markSeen).toHaveBeenCalledWith(['a']));
    expect(window.location.search).toBe('');
  });

  it('leaves another person’s item alone', async () => {
    window.history.replaceState(null, '', '/?delivery=not-mine');
    const { api } = fakeServer([]);
    render(
      <DeliveriesProvider api={api}>
        <DeliveryPushLinks />
      </DeliveriesProvider>,
    );
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('not-mine'));
    expect(api.markSeen).not.toHaveBeenCalled();
  });
});
