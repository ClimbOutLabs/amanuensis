'use client';

import { useEffect, useState } from 'react';

import { useAssistantDisplayName } from '../components/PersonalizationContext.js';
import { useOptionalDeliveries } from '../deliveries/DeliveriesContext.js';
import { enablePush, pushStatus, pushSupport } from '../deliveries/pushDevice.js';
import { createBooleanDisplayPreference } from '../utils/booleanDisplayPreference.js';

type Offer = 'checking' | 'offer' | 'none';

export const REMINDER_NOTICE_OFFER_DECLINED_STORAGE_KEY = 'aman.reminder_notice_offer_declined';

/** "Not now" is an answer for this device, so it is kept in this browser and outlives a reload. */
const offerDeclined = createBooleanDisplayPreference({
  storageKey: REMINDER_NOTICE_OFFER_DECLINED_STORAGE_KEY,
  defaultValue: false,
});

/**
 * Shown under the latest reply that set a reminder, when this device could take notices but has not turned
 * them on. "Not now" hides it on this device for good. Settings, Reach me, turns them on or off at any time.
 */
export function ReminderNotificationPrompt() {
  const deliveries = useOptionalDeliveries();
  const assistant = useAssistantDisplayName();
  const [offer, setOffer] = useState<Offer>('checking');
  const [error, setError] = useState<string | null>(null);
  const api = deliveries?.api;
  const declined = offerDeclined.useValue();

  useEffect(() => {
    if (api === undefined || pushSupport().blocker !== null) {
      setOffer('none');
      return;
    }
    let cancelled = false;
    void pushStatus({ api }).then(status => {
      if (!cancelled) setOffer(status.serverReady && !status.on ? 'offer' : 'none');
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (api === undefined || declined || offer !== 'offer') return null;
  return (
    <div
      data-role="reminder-notification-prompt"
      className="border-border bg-secondary-bg text-text-primary mt-2 rounded-xl border px-3 py-2 text-sm"
    >
      <p>
        Want a notice on this device when a reminder is due? {assistant} can show one even when {assistant} is closed.
        It says only that a reminder is there.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => {
            setError(null);
            void enablePush({ api, label: 'This device', assistant })
              .then(() => setOffer('none'))
              .catch((caught: unknown) => {
                console.error(caught);
                setError(
                  caught instanceof Error
                    ? caught.message
                    : 'Notices could not be turned on. Reload the page, then try again.',
                );
              });
          }}
          className="bg-primary-button-bg text-primary-button-text rounded-lg px-3 py-1 text-sm font-medium"
        >
          Turn on notices
        </button>
        <button
          type="button"
          onClick={() => offerDeclined.set(true)}
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
