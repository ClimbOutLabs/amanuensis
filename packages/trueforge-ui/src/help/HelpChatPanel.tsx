'use client';

import { useAui } from '@assistant-ui/react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { cn } from '../atoms/lib/cn.js';
import { Button } from '../atoms/primitives/Button.js';
import { useOptionalComposerBusyState } from '../hooks/useComposerBusyState.js';
import { Icon } from '../icons/Icon.js';
import {
  buildIrisHelpMessage,
  formatLastFullCheck,
  IRIS_HELP_CHOICES,
  sortHelpItems,
  youWereOnLine,
  type HelpHealthCheck,
  type HelpHealthItem,
  type HelpHealthStatus,
} from './helpModel.js';
import { useOptionalHelp, type HelpContextValue, type HelpSession } from './HelpProvider.js';

const ITEM_ICON: Record<HelpHealthStatus, string> = {
  fail: 'circle-exclamation',
  warn: 'triangle-exclamation',
  pass: 'circle-check',
  not_set_up: 'circle-check',
};

const ITEM_TEXT_CLASS: Record<HelpHealthStatus, string> = {
  fail: 'text-danger',
  warn: 'text-warning',
  pass: 'text-success',
  not_set_up: 'text-text-secondary',
};

const ITEM_WORD: Record<HelpHealthStatus, string> = {
  fail: 'Needs fixing',
  warn: 'Needs a look',
  pass: 'OK',
  not_set_up: 'Not set up',
};

const SECTION_CLASS = 'flex w-full max-w-3xl flex-col gap-3 rounded-xl border border-border bg-card-bg p-4';

/** Sends a message as the person's own, through the composer, the same way the tour's cards do. */
function useSendAsPerson(): (text: string) => void {
  const aui = useAui();
  const busy = useOptionalComposerBusyState();
  return (text: string) => {
    aui.composer().setText(text);
    const send = () => aui.composer().send();
    if (busy === null) {
      send();
    } else {
      busy.send(send);
    }
  };
}

/**
 * Runs the health check once per run, then has Iris speak first, but only when the model answered
 * and Iris is installed. Anything else keeps the results and the next steps on screen. The run
 * guard makes sure one run sends at most one message, even when effects run twice.
 */
function useHelpRunner(help: HelpContextValue | null): void {
  const sendAsPerson = useSendAsPerson();
  const startedRun = useRef<number | null>(null);

  useEffect(() => {
    if (help === null || help.session === null || help.api === null) {
      return;
    }
    const { api, update } = help;
    const session = help.session;
    if (session.phase !== 'pending' || startedRun.current === session.runKey) {
      return;
    }
    startedRun.current = session.runKey;
    const run = async () => {
      update({ phase: 'checking' });
      let check: HelpHealthCheck;
      try {
        check = await api.getHealthCheck();
      } catch {
        update({ phase: 'check_failed' });
        return;
      }
      update({ check });
      if (!check.model_ready) {
        update({ phase: 'no_model' });
        return;
      }
      update({ phase: 'joining' });
      let ready: boolean;
      try {
        ready = await api.ensureGuide();
      } catch {
        ready = false;
      }
      if (!ready) {
        update({ phase: 'unavailable' });
        return;
      }
      const message = buildIrisHelpMessage({ check, screen: session.screen, lastError: session.lastError });
      try {
        sendAsPerson(message);
        update({ phase: 'joined', sentMessage: message });
      } catch {
        update({ phase: 'unavailable' });
      }
    };
    void run();
  }, [help, sendAsPerson]);
}

function ItemRow({ item }: { item: HelpHealthItem }) {
  return (
    <li className="flex flex-col gap-1 border-b border-border py-2 last:border-b-0">
      <div className={cn('flex items-center gap-2 text-sm font-semibold', ITEM_TEXT_CLASS[item.status])}>
        <Icon name={ITEM_ICON[item.status]} aria-hidden />
        <span>{item.name}</span>
        <span className="font-normal">({ITEM_WORD[item.status]})</span>
      </div>
      <p className="text-sm text-text-primary">{item.message}</p>
      {item.next_step === null ? null : <p className="text-sm text-text-secondary">{item.next_step}</p>}
    </li>
  );
}

function HostReportLine({ help }: { help: HelpContextValue }) {
  const session = help.session;
  const report = session?.check?.host_report;
  if (report === undefined) {
    return null;
  }
  if (report.state === 'ok' && report.checked_at !== null) {
    return <p className="text-sm text-text-secondary">Last full check: {formatLastFullCheck(report.checked_at)}</p>;
  }
  return (
    <p className="text-sm text-danger">
      {report.message}
      {report.next_step === null ? null : ` ${report.next_step}`}
    </p>
  );
}

function phaseLine(session: HelpSession): string | null {
  switch (session.phase) {
    case 'pending':
    case 'checking':
      return 'Checking Aman. This takes a few seconds.';
    case 'joining':
      return 'Iris is joining this chat.';
    case 'unavailable':
      return 'Iris could not join this chat. Run aman doctor on your computer, then press Check again.';
    case 'check_failed':
      return 'The check could not run. Check your connection, then press Check again.';
    case 'no_model':
      return 'Add a model to get started. Token Factory is one option.';
    case 'joined':
      return null;
  }
}

/** The results, shown at the top of the help chat, with the next step for each problem. */
export function HelpChatPanel() {
  const help = useOptionalHelp();
  useHelpRunner(help);
  const statusId = useId();
  if (help === null || help.session === null) {
    return null;
  }
  const session = help.session;
  const line = phaseLine(session);
  const showCheckAgain = session.phase !== 'joined' && session.phase !== 'joining' && session.phase !== 'checking';
  return (
    <section aria-labelledby={statusId} className="mx-auto flex w-full flex-col items-center gap-3 px-4 pt-4">
      <div className={SECTION_CLASS} data-testid="help-chat-results">
        <h2 id={statusId} className="text-base font-semibold text-text-primary">
          Quick health check
        </h2>
        {line === null ? null : (
          <p role="status" className="text-sm text-text-secondary">
            {line}
          </p>
        )}
        {session.check === null ? null : (
          <>
            <ul className="m-0 list-none p-0">
              {sortHelpItems(session.check.items).map(item => (
                <ItemRow key={item.id} item={item} />
              ))}
            </ul>
            <HostReportLine help={help} />
          </>
        )}
        <p className="text-sm text-text-secondary">
          {youWereOnLine({ screen: session.screen, lastError: session.lastError })}
        </p>
        {showCheckAgain ? (
          <div>
            <Button type="button" variant="secondary" size="small" onClick={help.checkAgain}>
              Check again
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The one-tap answers under Iris's first message, and a box for anything else. Tapping sends the
 * choice as the person's own message.
 */
export function HelpChoices() {
  const help = useOptionalHelp();
  const sendAsPerson = useSendAsPerson();
  const [typed, setTyped] = useState('');
  const groupId = useId();
  if (help === null || help.session === null || help.session.phase !== 'joined') {
    return null;
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = typed.trim();
    if (text === '') {
      return;
    }
    sendAsPerson(text);
    setTyped('');
  };
  return (
    <section aria-labelledby={groupId} className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pb-4">
      <h2 id={groupId} className="sr-only">
        Choose where you are stuck
      </h2>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0" data-testid="help-choices">
        {IRIS_HELP_CHOICES.map(choice => (
          <li key={choice}>
            <Button type="button" variant="secondary" size="small" onClick={() => sendAsPerson(choice)}>
              {choice}
            </Button>
          </li>
        ))}
      </ul>
      <form className="flex gap-2" onSubmit={submit}>
        <label className="sr-only" htmlFor={`${groupId}-text`}>
          Tell Iris in your own words
        </label>
        <input
          id={`${groupId}-text`}
          value={typed}
          onChange={event => setTyped(event.target.value)}
          placeholder="Or tell Iris in your own words"
          className="min-w-0 flex-1 rounded-lg border border-border bg-card-bg px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring/40"
        />
        <Button type="submit" variant="secondary" size="small">
          Send
        </Button>
      </form>
    </section>
  );
}
