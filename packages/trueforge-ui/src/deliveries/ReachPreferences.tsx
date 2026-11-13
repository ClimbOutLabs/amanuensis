'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { Switch } from '../atoms/primitives/Switch.js';
import { useAssistantDisplayName } from '../components/PersonalizationContext.js';
import { BUTTON, CARD, Check, INPUT } from './reachFields.js';
import { TextsSettings } from './TextsSettings.js';
import {
  NOTICING_KINDS,
  type NoticingKind,
  type ReachApi,
  type ReachSender,
  type ReachSettings,
  type ReachSuggestion,
  type ReachTestChannel,
  type ReachView,
} from './types.js';

const KIND_WORDS: Record<NoticingKind, string> = {
  mail_always: 'Mail from someone on your always-important list',
  calendar_clash: 'Two things on your calendar at the same time',
  travel: 'Time to leave for an event with a place',
  bill_due: 'A bill or deadline coming up',
  approval_waiting: 'An approval waiting for you',
};

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function NumberField({
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (next: number) => void;
}) {
  return (
    <label className="text-text-primary flex flex-wrap items-center gap-2 text-sm">
      <span className="w-60 max-w-full">{label}</span>
      <input
        type="number"
        aria-label={label}
        className={`${INPUT} w-24`}
        min={min}
        max={max}
        value={value}
        onChange={event => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(Math.round(next));
        }}
      />
      <span className="text-text-secondary">{unit}</span>
    </label>
  );
}

const SIGN_IN_STEP = 'Open Settings, Connectors, Google and choose Reconnect to sign in to Google again.';

function mailNextStep({ kind, assistant }: { kind: NonNullable<ReachView['mailProblem']>['kind']; assistant: string }) {
  switch (kind) {
    case 'too_slow':
      return `Wait for ${assistant} to catch up. If this lasts a day, ask whoever runs your mail.`;
    case 'google_sign_in':
      return SIGN_IN_STEP;
    case 'email_password':
      return 'Open Settings, Connectors, Email. Make a new app password and save it again.';
    case 'other':
      return 'Open Settings, Connectors, and check that your mail is still connected.';
  }
}

/** Shown only once mail has gone unchecked for about an hour, so a short hiccup never worries anyone. */
function MailProblem({ problem }: { problem: NonNullable<ReachView['mailProblem']> }) {
  const assistant = useAssistantDisplayName();
  const since = new Date(problem.since).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div role="status" className={`${CARD} flex flex-col gap-1`}>
      <p className="text-text-primary text-sm font-semibold">{`${assistant} has not been able to check your mail since ${since}.`}</p>
      <p className="text-text-secondary text-sm">{mailNextStep({ kind: problem.kind, assistant })}</p>
    </div>
  );
}

/** Shown only once the calendar has gone unchecked for about an hour. */
function CalendarProblem({ problem }: { problem: NonNullable<ReachView['calendarProblem']> }) {
  const assistant = useAssistantDisplayName();
  const since = new Date(problem.since).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div role="status" className={`${CARD} flex flex-col gap-1`}>
      <p className="text-text-primary text-sm font-semibold">{`${assistant} has not been able to check your calendar since ${since}.`}</p>
      <p className="text-text-secondary text-sm">
        {problem.kind === 'google_sign_in'
          ? SIGN_IN_STEP
          : 'Open Settings, Connectors, and check that your calendar is still connected.'}
      </p>
    </div>
  );
}

const MAIL_SOURCE_WORDS = {
  google: 'your Google mail',
  email_connector: 'the mail from the shared Email connector',
} as const;

function MailSource({ source }: { source: NonNullable<ReachView['mailSource']> }) {
  const assistant = useAssistantDisplayName();
  return (
    <p className="text-text-secondary text-sm" data-role="mail-source">
      {`${assistant} is watching ${MAIL_SOURCE_WORDS[source]}.`}
    </p>
  );
}

function Card({ title, children, intro }: { title: string; children: ReactNode; intro?: string }) {
  return (
    <div className={CARD}>
      <h3 className="text-text-primary text-sm font-semibold">{title}</h3>
      {intro === undefined ? null : <p className="text-text-secondary mt-1 text-sm">{intro}</p>}
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </div>
  );
}

/** The one switch for the background checks. It saves at once, so turning it off never waits on the Save button. */
function NoticingSwitch({
  on,
  busy,
  error,
  onChange,
}: {
  on: boolean;
  busy: boolean;
  error: string | null;
  onChange: (next: boolean) => void;
}) {
  const assistant = useAssistantDisplayName();
  return (
    <div data-role="noticing-switch" className={`${CARD} flex flex-col gap-2`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p id="noticing-switch-label" className="text-text-primary text-sm font-semibold">
            {`Let ${assistant} watch for things`}
          </p>
          <p className="text-text-secondary mt-1 text-sm">
            {`${assistant} checks your mail every 10 minutes, your calendar every 30 minutes and waiting approvals every 5 minutes. Reminders you set work either way.`}
          </p>
        </div>
        <Switch
          size="md"
          aria-labelledby="noticing-switch-label"
          checked={on}
          disabled={busy}
          onCheckedChange={onChange}
        />
      </div>
      {error === null ? null : (
        <p role="alert" className="text-failure-text text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

/** Settings, Reach me: which channels may be used, whose mail matters, what may call, quiet hours and limits. */
export function ReachPreferences({ reach }: { reach: ReachApi }) {
  const assistant = useAssistantDisplayName();
  const [view, setView] = useState<ReachView | null>(null);
  const [draft, setDraft] = useState<ReachSettings | null>(null);
  const [suggestions, setSuggestions] = useState<ReachSuggestion[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [trial, setTrial] = useState<Partial<Record<ReachTestChannel, string>>>({});
  const [newAddress, setNewAddress] = useState('');
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    try {
      const loaded = await reach.get();
      // A person who has not saved yet starts from the quiet defaults, in their own time zone.
      setView(loaded);
      setDraft(loaded.saved ? loaded.settings : { ...loaded.settings, timezone: browserTimezone() });
      setLoadError(null);
      setSuggestions(await reach.suggestions().catch((): ReachSuggestion[] => []));
    } catch (caught) {
      setLoadError(
        caught instanceof Error ? caught.message : 'Your Reach me settings could not be loaded. Reload the page.',
      );
    }
  }, [reach]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError !== null) {
    return (
      <p role="alert" className="text-failure-text text-sm">
        {loadError}
      </p>
    );
  }
  if (view === null || draft === null) return null;

  const change = (patch: Partial<ReachSettings>) => {
    setDraft({ ...draft, ...patch });
    setStatus(null);
  };

  const addSender = (sender: Pick<ReachSender, 'address' | 'name' | 'source'>) => {
    const address = sender.address.trim().toLowerCase();
    if (address === '' || draft.alwaysImportant.some(existing => existing.address === address)) return;
    change({
      alwaysImportant: [...draft.alwaysImportant, { ...sender, address, addedAt: new Date().toISOString() }],
    });
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const saved = await reach.save(draft);
      setView(saved);
      setDraft(saved.settings);
      setSuggestions(await reach.suggestions().catch((): ReachSuggestion[] => []));
      setStatus({ tone: 'ok', text: 'Saved.' });
    } catch (caught) {
      setStatus({ tone: 'error', text: caught instanceof Error ? caught.message : 'Could not save. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  // Only the switch is saved: other changes on the page still wait for Save.
  const switchNoticing = async (next: boolean) => {
    setSwitching(true);
    setSwitchError(null);
    try {
      const base = view.saved ? view.settings : { ...view.settings, timezone: draft.timezone };
      const saved = await reach.save({ ...base, noticingOn: next });
      setView(saved);
      setDraft({ ...draft, noticingOn: saved.settings.noticingOn });
    } catch (caught) {
      setSwitchError(caught instanceof Error ? caught.message : 'Could not change this. Try again.');
    } finally {
      setSwitching(false);
    }
  };

  const tryChannel = async (channel: ReachTestChannel) => {
    setTrial(current => ({ ...current, [channel]: 'Sending.' }));
    try {
      const { devicesReached } = await reach.test(channel);
      const text =
        channel === 'push'
          ? devicesReached > 0
            ? `Sent to ${String(devicesReached)} ${devicesReached === 1 ? 'device' : 'devices'}.`
            : 'Sent, but no device has notices turned on.'
          : 'Sent. Look under the bell.';
      setTrial(current => ({ ...current, [channel]: text }));
    } catch (caught) {
      setTrial(current => ({
        ...current,
        [channel]: caught instanceof Error ? caught.message : 'That test did not go through. Try again in a minute.',
      }));
    }
  };

  const tryButton = (channel: ReachTestChannel, disabled = false) => (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={disabled}
        aria-label={`Try ${channel === 'in_app' ? 'in-app' : channel === 'push' ? 'push' : channel === 'text' ? 'texts' : 'calls'}`}
        onClick={() => void tryChannel(channel)}
        className={BUTTON}
      >
        Try it
      </button>
      <span role="status" className="text-text-secondary text-sm">
        {trial[channel] ?? ''}
      </span>
    </span>
  );

  const { availability } = view;
  // Call kinds, quiet hours and the gap between calls only matter once calls exist, so they wait until then.
  const callsReady = availability.calls.available;
  const callable = NOTICING_KINDS.filter(kind => view.maxLevels[kind] === 'call');
  const pending = suggestions.filter(
    suggestion =>
      !draft.alwaysImportant.some(sender => sender.address === suggestion.address) &&
      !draft.dismissedSuggestions.includes(suggestion.address),
  );

  return (
    <div data-role="reach-preferences" className="flex flex-col gap-4">
      <NoticingSwitch
        on={view.settings.noticingOn}
        busy={switching}
        error={switchError}
        onChange={next => void switchNoticing(next)}
      />
      {view.mailProblem === null ? null : <MailProblem problem={view.mailProblem} />}
      {view.calendarProblem === null ? null : <CalendarProblem problem={view.calendarProblem} />}
      {view.mailSource === null ? null : <MailSource source={view.mailSource} />}
      <Card title="Ways to reach you" intro="In the app is always on. Notices on this device are set up above.">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-text-primary text-sm">In the app, under the bell</span>
          {tryButton('in_app')}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-text-primary text-sm">Notices on your devices</span>
          {tryButton('push')}
        </div>
        {availability.texts.available ? (
          <TextsSettings
            texts={reach.texts}
            textsOn={draft.textsOn}
            savedOn={view.settings.textsOn}
            onTextsOn={next => change({ textsOn: next })}
            problem={availability.texts.problem}
            tryButton={tryButton('text', !view.settings.textsOn)}
          />
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-2">
            <Check label="Texts" checked={false} disabled note={availability.texts.note} onChange={() => undefined} />
            {tryButton('text', true)}
          </div>
        )}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <Check
            label="Phone calls"
            checked={draft.callsOn}
            disabled={!availability.calls.available}
            note={availability.calls.note}
            onChange={next => change({ callsOn: next })}
          />
          {tryButton('call', !availability.calls.available)}
        </div>
      </Card>

      <Card
        title="Mail that always matters"
        intro={`${assistant} tells you about mail from these people, as long as your mail server confirms the sender. Anything else it only mentions when it names a bill or deadline. This needs a Google account. With the shared Email connector, senders cannot be confirmed yet, so their mail is treated as ordinary mail.`}
      >
        {draft.alwaysImportant.length === 0 ? (
          <p className="text-text-secondary text-sm">No one yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {draft.alwaysImportant.map(sender => (
              <li key={sender.address} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-text-primary break-all">
                  {sender.name === null ? sender.address : `${sender.name} (${sender.address})`}
                </span>
                <button
                  type="button"
                  className={BUTTON}
                  aria-label={`Remove ${sender.address}`}
                  onClick={() =>
                    change({ alwaysImportant: draft.alwaysImportant.filter(item => item.address !== sender.address) })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={event => {
            event.preventDefault();
            addSender({ address: newAddress, name: newName.trim() === '' ? null : newName.trim(), source: 'settings' });
            setNewAddress('');
            setNewName('');
          }}
        >
          <input
            type="email"
            aria-label="Email address"
            placeholder="dana@example.com"
            className={`${INPUT} w-64 max-w-full`}
            value={newAddress}
            onChange={event => setNewAddress(event.target.value)}
          />
          <input
            type="text"
            aria-label="Name (optional)"
            placeholder="Name (optional)"
            className={`${INPUT} w-40 max-w-full`}
            value={newName}
            onChange={event => setNewName(event.target.value)}
          />
          <button type="submit" className={BUTTON} disabled={newAddress.trim() === ''}>
            Add
          </button>
        </form>
        {pending.length === 0 ? null : (
          <div data-role="reach-suggestions" className="flex flex-col gap-2">
            <p className="text-text-secondary text-sm">
              {assistant} found these in what it remembers. Nothing is added until you say so.
            </p>
            <ul className="flex flex-col gap-2">
              {pending.map(suggestion => (
                <li key={suggestion.address} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="text-text-primary min-w-0">
                    <span className="break-all">{suggestion.address}</span>
                    <span className="text-text-secondary block">{suggestion.memory}</span>
                  </span>
                  <span className="flex gap-2">
                    <button
                      type="button"
                      className={BUTTON}
                      aria-label={`Add ${suggestion.address}`}
                      onClick={() => addSender({ address: suggestion.address, name: null, source: 'memory' })}
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      className={BUTTON}
                      aria-label={`No thanks for ${suggestion.address}`}
                      onClick={() =>
                        change({ dismissedSuggestions: [...draft.dismissedSuggestions, suggestion.address] })
                      }
                    >
                      No thanks
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {callsReady ? (
        <>
          <Card
            title="What may call you"
            intro="Nothing calls unless you tick it here. Bills and waiting approvals can nudge you but never call."
          >
            {callable.map(kind => (
              <Check
                key={kind}
                label={KIND_WORDS[kind]}
                checked={draft.callKinds.includes(kind)}
                onChange={next =>
                  change({
                    callKinds: next ? [...draft.callKinds, kind] : draft.callKinds.filter(item => item !== kind),
                  })
                }
              />
            ))}
            <Check
              label="Call me for reminders I mark urgent"
              checked={draft.callForUrgentReminders}
              onChange={next => change({ callForUrgentReminders: next })}
            />
          </Card>

          <Card title="Quiet hours" intro="No calls during these hours. Nudges and notes still wait for you.">
            <Check
              label="Hold calls back during quiet hours"
              checked={draft.quietHours.enabled}
              onChange={next => change({ quietHours: { ...draft.quietHours, enabled: next } })}
            />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="text-text-primary flex items-center gap-2">
                From
                <input
                  type="time"
                  className={INPUT}
                  value={draft.quietHours.start}
                  onChange={event => change({ quietHours: { ...draft.quietHours, start: event.target.value } })}
                />
              </label>
              <label className="text-text-primary flex items-center gap-2">
                to
                <input
                  type="time"
                  className={INPUT}
                  value={draft.quietHours.end}
                  onChange={event => change({ quietHours: { ...draft.quietHours, end: event.target.value } })}
                />
              </label>
            </div>
          </Card>
        </>
      ) : (
        <p className="text-text-secondary text-sm">Call settings appear here once phone calls are set up.</p>
      )}

      <Card title="How often and how early" intro="The day starts at midnight in your time zone.">
        <NumberField
          label="Most nudges in one day"
          value={draft.maxNudgesPerDay}
          min={0}
          max={50}
          unit="nudges. After that, it waits as a note."
          onChange={next => change({ maxNudgesPerDay: next })}
        />
        {callsReady ? (
          <NumberField
            label="Fewest hours between two calls"
            value={draft.minHoursBetweenCalls}
            min={1}
            max={72}
            unit="hours"
            onChange={next => change({ minHoursBetweenCalls: next })}
          />
        ) : null}
        <NumberField
          label="Tell me about leaving"
          value={draft.travelLeadMinutes}
          min={15}
          max={1440}
          unit="minutes before an event with a place"
          onChange={next => change({ travelLeadMinutes: next })}
        />
        <label className="text-text-primary flex flex-wrap items-center gap-2 text-sm">
          <span className="w-60 max-w-full">Time zone</span>
          <input
            type="text"
            aria-label="Time zone"
            className={`${INPUT} w-60 max-w-full`}
            value={draft.timezone}
            onChange={event => change({ timezone: event.target.value })}
          />
        </label>
        <NumberField
          label="Say so when an approval waits"
          value={draft.approvalWaitMinutes}
          min={5}
          max={20}
          unit="minutes (a request closes after 30)"
          onChange={next => change({ approvalWaitMinutes: next })}
        />
      </Card>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="bg-primary-button-bg text-primary-button-text rounded-lg px-3 py-1.5 text-sm font-medium"
        >
          Save
        </button>
        {status === null ? null : (
          <span
            role={status.tone === 'error' ? 'alert' : 'status'}
            className={status.tone === 'error' ? 'text-failure-text text-sm' : 'text-text-secondary text-sm'}
          >
            {status.text}
          </span>
        )}
      </div>
    </div>
  );
}
