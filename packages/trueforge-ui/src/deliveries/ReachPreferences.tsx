'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { useAssistantDisplayName } from '../components/PersonalizationContext.js';
import { BUTTON, CARD, Check, INPUT } from './reachFields.js';
import { TextsSettings } from './TextsSettings.js';
import type {
  NoticingKind,
  ReachApi,
  ReachSender,
  ReachSettings,
  ReachSuggestion,
  ReachTestChannel,
  ReachView,
} from './types.js';

const KIND_WORDS: Record<NoticingKind, string> = {
  mail_always: 'Mail from someone on your always-important list',
  calendar_clash: 'Two things on your calendar at the same time',
  travel: 'Time to leave for an event with a place',
  bill_due: 'A bill or deadline coming up',
  approval_waiting: 'An approval waiting for you',
};

/** The order kinds are listed in. */
const KINDS: readonly NoticingKind[] = ['mail_always', 'calendar_clash', 'travel', 'bill_due', 'approval_waiting'];

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

function Card({ title, children, intro }: { title: string; children: ReactNode; intro?: string }) {
  return (
    <div className={CARD}>
      <h3 className="text-text-primary text-sm font-semibold">{title}</h3>
      {intro === undefined ? null : <p className="text-text-secondary mt-1 text-sm">{intro}</p>}
      <div className="mt-3 flex flex-col gap-3">{children}</div>
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
      setLoadError(caught instanceof Error ? caught.message : 'Your Reach me settings could not be loaded.');
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
        [channel]: caught instanceof Error ? caught.message : 'That test did not go through.',
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
  const callable = KINDS.filter(kind => view.maxLevels[kind] === 'call');
  const pending = suggestions.filter(
    suggestion =>
      !draft.alwaysImportant.some(sender => sender.address === suggestion.address) &&
      !draft.dismissedSuggestions.includes(suggestion.address),
  );

  return (
    <div data-role="reach-preferences" className="flex flex-col gap-4">
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
        intro={`${assistant} tells you about mail from these people, as long as your mail server confirms the sender. Anything else it only mentions when it names a bill or deadline.`}
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

      <Card
        title="What may call you"
        intro="Nothing calls unless you tick it here, and only when phone calls are set up. Bills and waiting approvals can nudge you but never call."
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
        <label className="text-text-primary flex flex-wrap items-center gap-2 text-sm">
          Time zone
          <input
            type="text"
            className={`${INPUT} w-60 max-w-full`}
            value={draft.timezone}
            onChange={event => change({ timezone: event.target.value })}
          />
        </label>
      </Card>

      <Card title="How often and how early">
        <NumberField
          label="Most nudges in one day"
          value={draft.maxNudgesPerDay}
          min={0}
          max={50}
          unit="nudges. After that, it waits as a note."
          onChange={next => change({ maxNudgesPerDay: next })}
        />
        <NumberField
          label="Fewest hours between two calls"
          value={draft.minHoursBetweenCalls}
          min={1}
          max={72}
          unit="hours"
          onChange={next => change({ minHoursBetweenCalls: next })}
        />
        <NumberField
          label="Tell me about leaving"
          value={draft.travelLeadMinutes}
          min={15}
          max={1440}
          unit="minutes before an event with a place"
          onChange={next => change({ travelLeadMinutes: next })}
        />
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
