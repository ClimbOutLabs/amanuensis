'use client';

import { parseClientJson } from '@truefoundry/trueforge-core/core/google/clientJson';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';

import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { Button } from '@/atoms/primitives/Button.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import type {
  GoogleClientCheck,
  GoogleClientDraft,
  GoogleConnectionStatus,
  GoogleConsentStart,
  GoogleFeature,
  GoogleSetupPort,
} from '@/server/googleSetup.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';

const GOOGLE_PROJECT_URL = 'https://console.cloud.google.com/projectcreate';
const GOOGLE_GMAIL_API_URL = 'https://console.cloud.google.com/apis/library/gmail.googleapis.com';
const GOOGLE_CONSENT_SCREEN_URL = 'https://console.cloud.google.com/apis/credentials/consent';
const GOOGLE_CREDENTIALS_URL = 'https://console.cloud.google.com/apis/credentials';

const STATUS_POLL_MS = 2000;
const STATUS_POLL_LIMIT = 300;

type GoogleSetupPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  port: GoogleSetupPort;
  /** Called after anything that changes the connection, so the list can refresh. */
  onChanged: () => void;
};

type ClientEntry = GoogleClientDraft & { registeredRedirectUris: string[] };

const EMPTY_CLIENT: ClientEntry = { clientId: '', clientSecret: '', clientType: null, registeredRedirectUris: [] };

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1 flex items-center gap-2">
      <code
        aria-label={label}
        className="min-w-0 flex-1 truncate rounded border border-border bg-primary-bg px-2 py-1 font-mono text-xs"
      >
        {value}
      </code>
      <Button
        variant="secondary"
        size="small"
        type="button"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 1500);
            },
            () => {
              setCopied(false);
            },
          );
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

function grantedFeatures(status: GoogleConnectionStatus): GoogleFeature[] {
  return status.features.filter(item => item.granted).map(item => item.feature);
}

function describeTest(result: 'ok' | 'not_connected' | 'needs_reconnect' | 'unreachable', account: string | null) {
  switch (result) {
    case 'ok':
      return `Working. Connected as ${account ?? 'your Google account'}.`;
    case 'not_connected':
      return 'Google is not connected.';
    case 'needs_reconnect':
      return 'Reconnect needed. Google no longer accepts the saved login. Click Reconnect.';
    case 'unreachable':
      return "Aman couldn't reach Google just now. Try again in a minute.";
  }
}

/**
 * Guided Google connection. The user brings their own Google client; the secret is typed or dropped here,
 * sent once to begin the consent, and never shown again.
 */
export function GoogleSetupPanel({ open, onOpenChange, port, onChanged }: GoogleSetupPanelProps) {
  const [status, setStatus] = useState<GoogleConnectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [client, setClient] = useState<ClientEntry>(EMPTY_CLIENT);
  const [check, setCheck] = useState<GoogleClientCheck | null>(null);
  const [allowCompose, setAllowCompose] = useState(false);
  const [begun, setBegun] = useState<GoogleConsentStart | null>(null);
  const [pasted, setPasted] = useState('');
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const pollRef = useRef(0);

  const refreshStatus = useCallback(async (): Promise<GoogleConnectionStatus | null> => {
    try {
      const next = await port.getGoogleStatus();
      setStatus(next);
      return next;
    } catch (err) {
      setError(getErrorMessage(err, 'Could not read the Google connection'));
      return null;
    }
  }, [port]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    setBegun(null);
    setCheck(null);
    setConfirmDisconnect(false);
    void refreshStatus();
    return () => {
      pollRef.current += 1;
    };
  }, [open, refreshStatus]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(getErrorMessage(err, 'Request failed'));
    } finally {
      setBusy(false);
    }
  };

  const loadClientJson = (text: string) => {
    const parsed = parseClientJson(text);
    if (parsed === null) {
      setError('That file is not a Google OAuth client file. Download the JSON of the client you created.');
      return;
    }
    setError(null);
    setCheck(null);
    setClient({
      clientId: parsed.client_id,
      clientSecret: parsed.client_secret,
      clientType: parsed.client_type,
      registeredRedirectUris: parsed.redirect_uris,
    });
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file !== undefined) void file.text().then(loadClientJson);
  };

  const hasClient = client.clientId.trim() !== '' && client.clientSecret.trim() !== '';

  const checkClient = () =>
    run(async () => {
      setCheck(await port.checkGoogleClient({ client, registeredRedirectUris: client.registeredRedirectUris }));
    });

  const waitForConsent = async (before: GoogleConnectionStatus) => {
    const ticket = (pollRef.current += 1);
    for (let attempt = 0; attempt < STATUS_POLL_LIMIT && pollRef.current === ticket; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, STATUS_POLL_MS));
      const next = await refreshStatus();
      if (
        next?.state === 'connected' &&
        (before.state !== 'connected' || grantedFeatures(next).length !== grantedFeatures(before).length)
      ) {
        setBegun(null);
        setNotice('Google is connected.');
        onChanged();
        return;
      }
    }
  };

  const beginConsent = (input: { useSavedClient: boolean; features: GoogleFeature[] }) =>
    run(async () => {
      if (status === null) return;
      const start = await port.beginGoogleConsent({
        client: input.useSavedClient ? null : client,
        features: input.features,
      });
      setClient(current => ({ ...current, clientSecret: '' }));
      setBegun(start);
      window.open(start.authorizationUrl, '_blank', 'noopener');
      if (start.setup.mode !== 'paste') void waitForConsent(status);
    });

  const finishPasted = () =>
    run(async () => {
      const next = await port.completeGoogleConsent({ address: pasted });
      setStatus(next);
      setPasted('');
      setBegun(null);
      setNotice('Google is connected.');
      onChanged();
    });

  const testConnection = () =>
    run(async () => {
      const result = await port.testGoogleConnection();
      setTestMessage(describeTest(result.result, result.accountEmail));
      await refreshStatus();
    });

  const disconnect = () =>
    run(async () => {
      const result = await port.disconnectGoogle();
      setConfirmDisconnect(false);
      if (result.disconnected) {
        setNotice('Google is disconnected and its access was revoked.');
        setTestMessage(null);
        await refreshStatus();
        onChanged();
      } else {
        setError('Google could not confirm the revocation yet, so nothing was removed here. Try again in a moment.');
      }
    });

  const setup = status?.setup;
  const clientTypeName = setup?.clientType === 'web' ? 'Web application' : 'Desktop app';

  return (
    <CenteredModal
      open={open}
      onOpenChange={onOpenChange}
      title="Google"
      description="Connect your Google account so Aman can read your email and, with your approval, draft and send it."
      className="md:max-w-2xl"
    >
      <div className="space-y-5 px-5 py-5 text-sm text-text-primary">
        {error ? (
          <p role="alert" className="rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-failure-bg">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p
            role="status"
            className="rounded-md border border-success-bg/30 bg-success-bg/10 px-3 py-2 text-success-bg"
          >
            {notice}
          </p>
        ) : null}

        {status === null ? <p className="text-text-secondary">Loading…</p> : null}

        {status !== null && status.state !== 'not_connected' && begun === null ? (
          <section aria-labelledby="google-connected-heading" className="space-y-3">
            <h3 id="google-connected-heading" className="font-semibold">
              {status.state === 'needs_reconnect' ? 'Reconnect needed' : 'Connected'}
            </h3>
            {status.state === 'needs_reconnect' ? (
              <p className="rounded-md border border-warning-bg/40 bg-warning-bg/10 px-3 py-2">
                Google no longer accepts the saved login, so Gmail is paused. Other parts of Aman keep working. Click
                Reconnect to sign in again. If this keeps happening about once a week, your Google project is still
                unpublished: on the Audience page, click Publish app.
              </p>
            ) : (
              <p className="text-text-secondary">{status.accountEmail ?? 'Your Google account'}</p>
            )}
            <ul className="space-y-1 text-text-secondary">
              {status.features.map(item => (
                <li key={item.feature}>
                  {item.label}: {item.granted ? 'allowed' : 'not allowed'}
                </li>
              ))}
            </ul>
            {testMessage ? (
              <p role="status" className="text-text-secondary">
                {testMessage}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {status.state === 'needs_reconnect' ? (
                <Button
                  size="small"
                  type="button"
                  disabled={busy}
                  onClick={() => void beginConsent({ useSavedClient: true, features: grantedFeatures(status) })}
                >
                  Reconnect
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="small"
                  type="button"
                  disabled={busy}
                  onClick={() => void testConnection()}
                >
                  Test connection
                </Button>
              )}
              {status.state === 'connected' && !grantedFeatures(status).includes('gmail_compose') ? (
                <Button
                  variant="secondary"
                  size="small"
                  type="button"
                  disabled={busy}
                  onClick={() => void beginConsent({ useSavedClient: true, features: ['gmail_compose'] })}
                >
                  Allow drafts and sending
                </Button>
              ) : null}
              <Button
                variant="destructive"
                size="small"
                type="button"
                disabled={busy}
                onClick={() => setConfirmDisconnect(true)}
              >
                Disconnect
              </Button>
            </div>
            {confirmDisconnect ? (
              <div
                role="alertdialog"
                aria-label="Confirm disconnect"
                className="rounded-md border border-border bg-primary-bg p-3"
              >
                <p>
                  This removes Aman&apos;s access to your Google account everywhere it is used and deletes the saved
                  login. Emails already sent stay in Gmail. You can connect again later.
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="destructive"
                    size="small"
                    type="button"
                    disabled={busy}
                    onClick={() => void disconnect()}
                  >
                    Disconnect Google
                  </Button>
                  <Button variant="ghost" size="small" type="button" onClick={() => setConfirmDisconnect(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {status?.state === 'not_connected' && setup !== undefined && begun === null ? (
          <ol className="list-decimal space-y-4 pl-5">
            <li>
              <p className="font-medium">Create a Google Cloud project</p>
              <p className="text-text-secondary">
                Use an existing project if you have one. It is free and takes a minute.
              </p>
              <CopyField label="Project link" value={GOOGLE_PROJECT_URL} />
            </li>
            <li>
              <p className="font-medium">Turn on the Gmail API</p>
              <p className="text-text-secondary">On the page, click Enable.</p>
              <CopyField label="Gmail API link" value={GOOGLE_GMAIL_API_URL} />
            </li>
            <li>
              <p className="font-medium">Set up the consent screen and publish it</p>
              <p className="text-text-secondary">
                Choose External, then fill in an app name and your email address. On the Audience page, click Publish
                app. Until then, Google asks you to sign in again every 7 days.
              </p>
              <CopyField label="Consent screen link" value={GOOGLE_CONSENT_SCREEN_URL} />
            </li>
            <li>
              <p className="font-medium">Create the client</p>
              <p className="text-text-secondary">
                For application type, choose {clientTypeName}.
                {setup.clientType === 'web'
                  ? ' This install has a public address, so add this exact authorized redirect URI:'
                  : ' It needs no redirect address.'}
              </p>
              {setup.clientType === 'web' ? <CopyField label="Redirect URI" value={setup.redirectUri} /> : null}
              <p className="mt-1 text-text-secondary">Click Create, then Download JSON.</p>
              <CopyField label="Credentials link" value={GOOGLE_CREDENTIALS_URL} />
            </li>
            <li>
              <p className="font-medium">Drop the downloaded JSON, or paste the client ID and secret</p>
              <div
                onDragOver={event => event.preventDefault()}
                onDrop={onDrop}
                className="mt-2 space-y-2 rounded-md border border-dashed border-border p-3"
              >
                <label className="block text-xs font-medium text-text-secondary" htmlFor="google-client-id">
                  Client ID
                </label>
                <input
                  id="google-client-id"
                  className={auiInputClass('h-10')}
                  value={client.clientId}
                  autoComplete="off"
                  onChange={event => setClient({ ...client, clientId: event.target.value })}
                />
                <label className="block text-xs font-medium text-text-secondary" htmlFor="google-client-secret">
                  Client secret
                </label>
                <input
                  id="google-client-secret"
                  type="password"
                  className={auiInputClass('h-10')}
                  value={client.clientSecret}
                  autoComplete="off"
                  onChange={event => setClient({ ...client, clientSecret: event.target.value })}
                />
                <label className="block text-xs font-medium text-text-secondary" htmlFor="google-client-json">
                  Or choose the downloaded client JSON
                </label>
                <input
                  id="google-client-json"
                  type="file"
                  accept="application/json,.json"
                  onChange={event => {
                    const file = event.target.files?.[0];
                    if (file !== undefined) void file.text().then(loadClientJson);
                  }}
                />
                <p className="text-xs text-text-secondary">The file is read in this browser.</p>
                <p className="text-xs text-text-secondary">
                  Your client secret goes to Aman once, to start sign-in, and is never shown again.
                </p>
              </div>
              <div className="mt-2">
                <Button
                  variant="secondary"
                  size="small"
                  type="button"
                  disabled={busy || !hasClient}
                  onClick={() => void checkClient()}
                >
                  Check my client
                </Button>
                {!hasClient ? (
                  <p className="mt-1 text-xs text-text-secondary">Add your client ID and secret first.</p>
                ) : null}
              </div>
              {check !== null ? (
                check.ok ? (
                  <p role="status" className="mt-2 text-success-bg">
                    No problems found with this client.
                  </p>
                ) : (
                  <ul role="alert" className="mt-2 list-disc space-y-1 pl-5 text-failure-bg">
                    {check.problems.map(problem => (
                      <li key={problem.code}>{problem.message}</li>
                    ))}
                  </ul>
                )
              ) : null}
            </li>
            <li>
              <p className="font-medium">Connect</p>
              <label className="mt-1 flex items-start gap-2 text-text-secondary">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={allowCompose}
                  onChange={event => setAllowCompose(event.target.checked)}
                />
                <span>Also let Aman save drafts and send email. Every draft and every send still asks you first.</span>
              </label>
              <p className="mt-2 text-text-secondary">
                Google will say it hasn&apos;t verified this app. That&apos;s because you made the app yourself. Click
                Advanced, then Go to your app, then Continue. A window opens for this, so allow pop-ups for this site if
                nothing appears.
              </p>
              <div className="mt-2">
                <Button
                  size="small"
                  type="button"
                  disabled={busy || !hasClient}
                  onClick={() =>
                    void beginConsent({
                      useSavedClient: false,
                      features: allowCompose ? ['gmail_read', 'gmail_compose'] : ['gmail_read'],
                    })
                  }
                >
                  Connect Google
                </Button>
                {!hasClient ? (
                  <p className="mt-1 text-xs text-text-secondary">Add your client ID and secret first.</p>
                ) : null}
              </div>
            </li>
          </ol>
        ) : null}

        {begun !== null ? (
          <section aria-labelledby="google-consent-heading" className="space-y-3">
            <h3 id="google-consent-heading" className="font-semibold">
              Finish in the Google window
            </h3>
            <p className="text-text-secondary">
              If no window opened, allow pop-ups for this site, or{' '}
              <a
                href={begun.authorizationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-text-primary underline"
              >
                open Google sign-in here
              </a>
              .
            </p>
            {begun.setup.mode !== 'paste' ? (
              <p className="text-text-secondary">Waiting for you to approve access. This panel updates by itself.</p>
            ) : (
              <>
                <p className="text-text-secondary">
                  After you approve, your browser shows a page that says &quot;This site can&apos;t be reached&quot;.
                  That&apos;s expected. Copy the whole address from the address bar of that page and paste it here. On
                  an iPhone or iPad, tap the address bar, choose Select All, then Copy, so you get the whole address.
                  The address works once, for this sign-in only.
                </p>
                <label className="block text-xs font-medium text-text-secondary" htmlFor="google-pasted-address">
                  Address from the address bar
                </label>
                <input
                  id="google-pasted-address"
                  type="text"
                  inputMode="url"
                  className={auiInputClass('h-10')}
                  value={pasted}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={event => setPasted(event.target.value)}
                />
                <Button
                  size="small"
                  type="button"
                  disabled={busy || pasted.trim() === ''}
                  onClick={() => void finishPasted()}
                >
                  Finish connecting
                </Button>
                {pasted.trim() === '' ? <p className="text-xs text-text-secondary">Paste the address first.</p> : null}
              </>
            )}
            <Button variant="ghost" size="small" type="button" onClick={() => setBegun(null)}>
              Cancel
            </Button>
          </section>
        ) : null}
      </div>
    </CenteredModal>
  );
}

export default GoogleSetupPanel;
