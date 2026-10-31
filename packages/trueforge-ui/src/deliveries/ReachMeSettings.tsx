'use client';

import { useCallback, useEffect, useState } from 'react';

import { useAssistantDisplayName } from '../components/PersonalizationContext.js';
import { useOptionalDeliveries } from './DeliveriesContext.js';
import { currentPushSubscription, disablePush, enablePush, pushSupport, type PushBlocker } from './pushDevice.js';

const BLOCKER_WORDS: Record<PushBlocker, string> = {
  unsupported:
    'This browser cannot show notices when Aman is closed. Try a recent version of Chrome, Edge, Firefox or Safari.',
  iphone_needs_home_screen:
    'On an iPhone, notices only work once Aman is on your Home Screen. Tap the Share button, choose Add to Home Screen, then open Aman from there and come back to this page.',
  denied:
    'This browser is blocking notices for this site. Allow them in the browser settings for this site, then come back here.',
};

type DeviceState = 'checking' | 'on' | 'off';

/** Settings, Reach me: turn on notices for this device, so a reminder reaches it with the page closed. */
export function ReachMeSettings() {
  const deliveries = useOptionalDeliveries();
  const assistant = useAssistantDisplayName();
  const [state, setState] = useState<DeviceState>('checking');
  const [serverReady, setServerReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const api = deliveries?.api;
  const support = pushSupport();

  useEffect(() => {
    if (api === undefined) return;
    let cancelled = false;
    void Promise.all([currentPushSubscription().catch(() => null), api.pushPublicKey().catch(() => null)]).then(
      ([subscription, key]) => {
        if (cancelled) return;
        setState(subscription === null ? 'off' : 'on');
        setServerReady(key !== null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const turnOn = useCallback(async () => {
    if (api === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await enablePush({ api, label: 'This device' });
      setState('on');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Notices could not be turned on. Try again.');
    } finally {
      setBusy(false);
    }
  }, [api]);

  const turnOff = useCallback(async () => {
    if (api === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await disablePush({ api });
      setState('off');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Notices could not be turned off. Try again.');
    } finally {
      setBusy(false);
    }
  }, [api]);

  if (api === undefined) return null;

  return (
    <section data-role="reach-me" className="flex flex-col gap-4">
      <div>
        <h2 className="text-text-primary text-lg font-semibold">Reach me</h2>
        <p className="text-text-secondary mt-1 text-sm">
          Choose how {assistant} reaches you. Everything it sends also waits under the bell in the top bar, with the
          reason you got it. Texts and phone calls are off.
        </p>
      </div>
      <div className="border-border rounded-xl border p-4">
        <h3 className="text-text-primary text-sm font-semibold">Notices on this device</h3>
        <p className="text-text-secondary mt-1 text-sm">
          A notice shows even when Aman is closed. It says only that something is there. The details open in Aman.
        </p>
        {support.blocker !== null ? (
          <p data-role="reach-me-blocker" className="text-text-primary mt-3 text-sm">
            {BLOCKER_WORDS[support.blocker]}
          </p>
        ) : serverReady === false ? (
          <p className="text-text-primary mt-3 text-sm">
            Notices are not set up on this server. Ask the person who runs it to turn them on.
          </p>
        ) : (
          <div className="mt-3 flex items-center gap-3">
            {state === 'on' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void turnOff()}
                className="text-text-primary border-border hover:bg-ghost-button-hover rounded-lg border px-3 py-1.5 text-sm"
              >
                Turn off on this device
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || state === 'checking'}
                onClick={() => void turnOn()}
                className="bg-primary-button-bg text-primary-button-text rounded-lg px-3 py-1.5 text-sm font-medium"
              >
                Turn on for this device
              </button>
            )}
            <span className="text-text-secondary text-sm" role="status">
              {state === 'on' ? 'On for this device.' : state === 'off' ? 'Off for this device.' : ''}
            </span>
          </div>
        )}
        {error === null ? null : (
          <p role="alert" className="text-failure-text mt-3 text-sm">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
