'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { BUTTON, Check, INPUT } from './reachFields.js';
import type { TextMode, TextsApi, TextStatus } from './types.js';

type Note = { tone: 'ok' | 'error'; text: string };

/**
 * Settings, Reach me: the number for texts. The person enters it, receives a code, confirms it, then chooses what
 * texts say and switches them on. Nothing is sent to a number before it is confirmed.
 */
export function TextsSettings({
  texts,
  textsOn,
  savedOn,
  onTextsOn,
  problem,
  tryButton,
}: {
  texts: TextsApi;
  textsOn: boolean;
  /** Whether texts are on as last saved. */
  savedOn: boolean;
  onTextsOn: (next: boolean) => void;
  /** A problem with texts on this server, worded for this person, or null. */
  problem: string | null;
  /** The Try it button, which the page draws the same way for every channel. */
  tryButton: ReactNode;
}) {
  const [status, setStatus] = useState<TextStatus | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [changing, setChanging] = useState(false);
  // Set when the person keeps their number after a code went to a new one, so the code entry is put away.
  const [kept, setKept] = useState(false);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await texts.status());
    } catch (caught) {
      setNote({ tone: 'error', text: caught instanceof Error ? caught.message : 'Your number could not be loaded.' });
    }
  }, [texts]);

  useEffect(() => {
    void load();
  }, [load]);

  // A number that is no longer confirmed, such as after a STOP, cannot have texts on.
  useEffect(() => {
    if (status !== null && !status.confirmed && textsOn) onTextsOn(false);
  }, [status, textsOn, onTextsOn]);

  if (status === null) {
    return note === null ? null : (
      <p role="alert" className="text-failure-text text-sm">
        {note.text}
      </p>
    );
  }

  const run = async (work: () => Promise<TextStatus | undefined>, done: string) => {
    setBusy(true);
    setNote(null);
    try {
      const next = await work();
      if (next !== undefined) setStatus(next);
      setNote({ tone: 'ok', text: done });
      return true;
    } catch (caught) {
      setNote({
        tone: 'error',
        text: caught instanceof Error ? caught.message : 'That did not go through. Try again.',
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async () => {
    const sent = await run(() => texts.sendCode(phone), 'A code was sent. Type it below within 10 minutes.');
    if (sent) {
      setCode('');
      setKept(false);
    }
  };

  const confirm = async () => {
    const confirmed = await run(() => texts.confirm(code), 'Your number is confirmed. Now switch texts on and save.');
    if (confirmed) {
      setChanging(false);
      setCode('');
      setPhone('');
    }
  };

  const setMode = (mode: TextMode) => {
    void run(() => texts.setMode(mode), mode === 'private' ? 'Texts are Private.' : 'Texts are Full.');
  };

  const addWord = async () => {
    const added = await run(() => texts.addWord(word), 'Added. Aman may text that word.');
    if (added) setWord('');
  };

  const removeWord = (listed: string) => {
    void run(() => texts.removeWord(listed), 'Removed.');
  };

  const remove = async () => {
    const removed = await run(async () => {
      await texts.remove();
      return await texts.status();
    }, 'Your number was removed. Texts are off.');
    if (removed) onTextsOn(false);
  };

  const waiting = status.pendingPhone !== null && status.codePending && !kept;
  const entering = status.phone === null || !status.confirmed || changing || waiting;

  return (
    <div data-role="texts-settings" className="flex w-full flex-col gap-3">
      <div>
        <span className="text-text-primary text-sm font-medium">Texts</span>
        <p className="text-text-secondary text-sm">Texts travel through Twilio and the phone company.</p>
      </div>

      {problem === null ? null : (
        <p role="alert" className="text-failure-text text-sm">
          {problem}
        </p>
      )}

      {status.optedOut ? (
        <p role="status" className="text-text-secondary text-sm">
          You replied STOP, so texts are off. To use them again, reply START from that phone, then confirm the number
          again here.
        </p>
      ) : null}

      {entering ? (
        <div className="flex flex-col gap-2">
          <label className="text-text-primary flex flex-wrap items-center gap-2 text-sm">
            <span className="w-40 max-w-full">Your phone number</span>
            <input
              type="tel"
              aria-label="Your phone number"
              className={`${INPUT} w-56`}
              placeholder="+15550100"
              value={phone}
              onChange={event => setPhone(event.target.value)}
            />
            <button
              type="button"
              className={BUTTON}
              disabled={busy || phone.trim() === ''}
              onClick={() => void sendCode()}
            >
              Send code
            </button>
          </label>
          <p className="text-text-secondary text-sm">
            Type it with the country code. We text it a code to prove it is yours. Nothing else is sent until then.
          </p>
          {status.confirmed && status.pendingPhone !== null ? (
            <p role="status" className="text-text-secondary text-sm">
              Texts keep going to {status.phone} until you confirm {status.pendingPhone}.
            </p>
          ) : null}
          {status.codePending ? (
            <label className="text-text-primary flex flex-wrap items-center gap-2 text-sm">
              <span className="w-40 max-w-full">Code from the text</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="Code from the text"
                className={`${INPUT} w-32`}
                value={code}
                onChange={event => setCode(event.target.value)}
              />
              <button
                type="button"
                className={BUTTON}
                disabled={busy || code.trim() === ''}
                onClick={() => void confirm()}
              >
                Confirm
              </button>
            </label>
          ) : null}
          {status.confirmed && (changing || waiting) ? (
            <div>
              <button
                type="button"
                className={BUTTON}
                onClick={() => {
                  setChanging(false);
                  setKept(true);
                }}
              >
                Keep my number
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-text-primary">
              Texts go to <span className="font-medium">{status.phone}</span>, which you confirmed.
            </span>
            <button type="button" className={BUTTON} onClick={() => setChanging(true)}>
              Change number
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void remove()}>
              Remove number
            </button>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-text-primary text-sm">What texts say</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="text-mode"
                className="mt-1"
                checked={status.mode === 'private'}
                disabled={busy}
                onChange={() => setMode('private')}
              />
              <span className="text-text-primary">
                Private (recommended)
                <span className="text-text-secondary block">
                  Only the kind of thing, such as “{status.privatePreview}” No names, amounts or message content.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="text-mode"
                className="mt-1"
                checked={status.mode === 'full'}
                disabled={busy}
                onChange={() => setMode('full')}
              />
              <span className="text-text-primary">
                Full
                <span className="text-text-secondary block">
                  A reminder’s own words, cut to fit two texts. Anything your assistant noticed still says only its
                  kind. A reminder with a word Aman does not know, a link, a long number or signs is sent as Private. It
                  can show on a locked screen and is seen by Twilio and the phone company.
                </span>
              </span>
            </label>
          </fieldset>
          <div data-role="text-words" className="flex flex-col gap-2">
            <span className="text-text-primary text-sm">Words Aman may text</span>
            <p className="text-text-secondary text-sm">
              Full texts carry common words, times, dates and amounts. Add a name, such as a doctor or a friend, to let
              it through. Letters only.
            </p>
            <label className="text-text-primary flex flex-wrap items-center gap-2 text-sm">
              <span className="w-40 max-w-full">A name or word</span>
              <input
                type="text"
                aria-label="A name or word"
                className={`${INPUT} w-40`}
                maxLength={60}
                value={word}
                onChange={event => setWord(event.target.value)}
              />
              <button
                type="button"
                className={BUTTON}
                disabled={busy || word.trim() === ''}
                onClick={() => void addWord()}
              >
                Add word
              </button>
            </label>
            {status.words.length === 0 ? null : (
              <ul className="flex flex-wrap gap-2">
                {status.words.map(listed => (
                  <li key={listed} className="text-text-primary flex items-center gap-1 text-sm">
                    <span>{listed}</span>
                    <button
                      type="button"
                      className={BUTTON}
                      aria-label={`Remove ${listed}`}
                      disabled={busy}
                      onClick={() => removeWord(listed)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <Check
              label="Send me texts"
              checked={textsOn}
              onChange={onTextsOn}
              {...(textsOn === savedOn ? {} : { note: 'Save to apply this.' })}
            />
            {tryButton}
          </div>
        </div>
      )}

      {note === null ? null : (
        <p
          role={note.tone === 'error' ? 'alert' : 'status'}
          className={note.tone === 'error' ? 'text-failure-text text-sm' : 'text-text-secondary text-sm'}
        >
          {note.text}
        </p>
      )}
    </div>
  );
}
