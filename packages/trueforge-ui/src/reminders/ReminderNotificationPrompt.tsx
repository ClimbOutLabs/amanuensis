'use client';

import { useEffect, useState } from 'react';

import { useAssistantDisplayName } from '../components/PersonalizationContext.js';
import { useOptionalDeliveries } from '../deliveries/DeliveriesContext.js';
import { currentPushSubscription, enablePush, pushSupport } from '../deliveries/pushDevice.js';

type Offer = 'checking' | 'offer' | 'none';

/**
 * Shown under a reminder that was just set, when this device could take notices but has not turned them on.
 * "Not now" hides it until the next reminder. Settings, Reach me, turns them on or off at any time.
 */
export function ReminderNotificationPrompt() {
  const deliveries = useOptionalDeliveries();
  const assistant = useAssistantDisplayName();
  const [offer, setOffer] = useState<Offer>('checking');
  const [error, setError] = useState<string | null>(null);
  const api = deliveries?.api;

  useEffect(() => {
    if (api === undefined || pushSupport().blocker !== null) {
      setOffer('none');
      return;
    }
    let cancelled = false;
    void Promise.all([currentPushSubscription().catch(() => null), api.pushPublicKey().catch(() => null)]).then(
      ([subscription, key]) => {
        if (!cancelled) setOffer(subscription === null && key !== null ? 'offer' : 'none');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (api === undefined || offer !== 'offer') return null;
  return (
    <div
      data-role="reminder-notification-prompt"
      className="border-border bg-secondary-bg text-text-primary mt-2 rounded-xl border px-3 py-2 text-sm"
    >
      <p>
        Want a notice on this device when a reminder is due? {assistant} can show one even when Aman is closed. It says
        only that a reminder is there.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => {
            setError(null);
            void enablePush({ api, label: 'This device' })
              .then(() => setOffer('none'))
              .catch((caught: unknown) =>
                setError(caught instanceof Error ? caught.message : 'Notices could not be turned on. Try again.'),
              );
          }}
          className="bg-primary-button-bg text-primary-button-text rounded-lg px-3 py-1 text-sm font-medium"
        >
          Turn on notices
        </button>
        <button
          type="button"
          onClick={() => setOffer('none')}
          className="text-text-secondary hover:bg-ghost-button-hover rounded-lg px-3 py-1 text-sm"
        >
          Not now
        </button>
      </div>
      {error === null ? null : (
        <p role="alert" className="mt-2">
          {error}
        </p>
      )}
    </div>
  );
}
