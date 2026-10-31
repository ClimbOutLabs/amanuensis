'use client';

import { useEffect } from 'react';

import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { useOptionalDeliveries } from './DeliveriesContext.js';
import { openDeliveryLink } from './openDelivery.js';

/** The page address carries `delivery` when a tapped notice opened a closed app. */
export const DELIVERY_QUERY_KEY = 'delivery';
/** The message the service worker sends to a page that was already open. */
export const OPEN_DELIVERY_MESSAGE = 'open_delivery';

function requestedIdFromAddress(): string | null {
  const id = new URLSearchParams(window.location.search).get(DELIVERY_QUERY_KEY);
  return id === null || id === '' ? null : id;
}

function clearRequestFromAddress(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete(DELIVERY_QUERY_KEY);
  window.history.replaceState(window.history.state, '', url);
}

/**
 * Opens the item a tapped notice names. The notice carries only an id, so the details are fetched here, once the
 * page is open. Mount it once, inside the shell.
 */
export function DeliveryPushLinks() {
  const deliveries = useOptionalDeliveries();
  const shell = useOptionalShellMode();
  const requestOpen = deliveries?.requestOpen;

  useEffect(() => {
    if (requestOpen === undefined) return;
    const fromAddress = requestedIdFromAddress();
    if (fromAddress !== null) {
      clearRequestFromAddress();
      requestOpen(fromAddress);
    }
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      if (Reflect.get(data, 'type') !== OPEN_DELIVERY_MESSAGE) return;
      const id: unknown = Reflect.get(data, 'delivery_id');
      if (typeof id === 'string' && id !== '') requestOpen(id);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [requestOpen]);

  const requestedId = deliveries?.requestedId ?? null;
  const api = deliveries?.api;
  const markSeen = deliveries?.markSeen;
  useEffect(() => {
    if (requestedId === null || api === undefined || markSeen === undefined || requestOpen === undefined) return;
    let cancelled = false;
    void api
      .get(requestedId)
      .then(item => {
        if (cancelled) return;
        requestOpen(null);
        if (item === null) return;
        void markSeen([item.id]);
        if (item.link !== null && shell !== null) openDeliveryLink({ shell, link: item.link });
      })
      .catch(() => {
        if (!cancelled) requestOpen(null);
      });
    return () => {
      cancelled = true;
    };
  }, [requestedId, api, markSeen, requestOpen, shell]);

  return null;
}
