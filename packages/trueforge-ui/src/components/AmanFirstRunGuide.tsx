'use client';

import { type FC, type ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import { useOptionalShellMode, type SettingsSection } from '../server/ShellModeContext.js';
import { assistantDisplayName } from '../utils/assistantName.js';
import { useOptionalAmanSetup } from './AmanSetupContext.js';
import { useOptionalPersonalization } from './PersonalizationContext.js';

/** Where a setup line sends the person: a Settings section. */
export type FirstRunTarget = { kind: 'settings'; section: SettingsSection };

export type SetupItem = {
  key: 'model' | 'about-you' | 'first-chat';
  label: string;
  done: boolean;
  /** What a finished line says on its right. */
  doneValue: string;
  /** The one action an open line offers; a line without one only says what is left. */
  action?: { label: string; target: FirstRunTarget };
};

function hasText(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim() !== '';
}

/**
 * The setup lines, computed from real state so they tick themselves off. The first-chat line is
 * listed only when the host knows whether a chat has started.
 */
export function setupTicketItems({
  assistantName,
  modelName,
  userName,
  hasChatted,
}: {
  assistantName: string;
  modelName: string | null | undefined;
  /** The profile's user name; undefined while the profile is still loading. */
  userName: string | null | undefined;
  hasChatted: boolean | undefined;
}): SetupItem[] {
  const items: SetupItem[] = [
    {
      key: 'model',
      label: 'Add a model',
      done: hasText(modelName),
      doneValue: modelName?.trim() ?? '',
      action: { label: 'Choose a model', target: { kind: 'settings', section: 'models' } },
    },
    {
      key: 'about-you',
      label: `Tell ${assistantName} about you`,
      done: hasText(userName),
      doneValue: userName?.trim() ?? '',
      action: { label: 'Open Personalization', target: { kind: 'settings', section: 'personalization' } },
    },
  ];
  if (hasChatted !== undefined) {
    items.push({ key: 'first-chat', label: 'Try your first chat', done: hasChatted, doneValue: 'Started' });
  }
  return items;
}

/** Whether the setup ticket is on screen: the owner has not skipped it, and it still has a line to do. */
export function isSetupTicketVisible(setup: { firstRunGuide?: { dismissed: boolean } } | null): boolean {
  return setup !== null && setup.firstRunGuide?.dismissed !== true;
}

/**
 * A line's action. Inside the shell it opens the section in place; outside it falls back to the
 * host's settings URL, and with neither it is plain text, so the line still says what to do.
 */
const FirstRunLink: FC<{ target: FirstRunTarget; settingsHref: string | undefined; children: ReactNode }> = ({
  target,
  settingsHref,
  children,
}) => {
  const shell = useOptionalShellMode();
  // A button takes the browser's own box and colour unless reset, which hides its text on dark paper.
  const className =
    'cursor-pointer appearance-none border-0 bg-transparent p-0 font-[inherit] text-[0.8125rem] text-gold-ink underline underline-offset-2';
  if (shell !== null) {
    return (
      <button type="button" className={className} onClick={() => shell.setSettingsOpen(true, target.section)}>
        {children}
      </button>
    );
  }
  if (settingsHref !== undefined) {
    return (
      <a className={className} href={settingsHref}>
        {children}
      </a>
    );
  }
  return <span className="text-[0.8125rem] text-gold-ink">{children}</span>;
};

/**
 * The setup ticket: three lines the person can finish in a minute, shown only on a first run. It
 * hides once every line is done or the owner skips it; the skip lives on the server, not here.
 */
export const AmanSetupTicket: FC = () => {
  const setup = useOptionalAmanSetup();
  const personalization = useOptionalPersonalization();
  if (!isSetupTicketVisible(setup) || setup === null) {
    return null;
  }
  // The profile is still on its way: a line that ticks a moment later would flicker.
  if (personalization !== null && personalization.loading) {
    return null;
  }
  const assistant = assistantDisplayName(personalization?.profile?.assistant_name);
  const items = setupTicketItems({
    assistantName: assistant,
    modelName: setup.modelName,
    userName: personalization?.profile?.user_name,
    hasChatted: setup.hasChatted,
  });
  const doneCount = items.filter(item => item.done).length;
  if (doneCount === items.length) {
    return null;
  }
  return (
    <section
      aria-labelledby="aman-setup-ticket-heading"
      data-testid="aman-setup-ticket"
      className="aui-settle w-full shrink-0 overflow-hidden rounded-[0.75rem] border border-border bg-card-bg text-left"
    >
      <header className="flex items-center justify-between gap-3 border-0 border-b border-dashed border-border px-4 py-3">
        <h2 id="aman-setup-ticket-heading" className="aui-face-serif m-0 text-[0.9375rem] font-normal">
          Set up {assistant}
        </h2>
        <p className="m-0 text-[0.8125rem] text-text-secondary">
          {doneCount} of {items.length} done
        </p>
      </header>
      <ol className="m-0 flex list-none flex-col p-0">
        {items.map((item, index) => (
          <li
            key={item.key}
            data-done={item.done}
            className={`flex min-h-11 items-center gap-3 px-4 py-[0.6875rem] text-sm ${index === 0 ? '' : 'border-t border-border'}`}
          >
            {item.done ? (
              <>
                <Icon name="circle-check" size={16} className="shrink-0 text-gold-ink" aria-hidden="true" />
                <span className="text-text-secondary line-through">{item.label}</span>
                <span className="ml-auto text-[0.8125rem] text-text-secondary">{item.doneValue}</span>
              </>
            ) : (
              <>
                <span
                  className="size-3.5 shrink-0 rounded-full border-[0.09375rem] border-gold-line"
                  aria-hidden="true"
                />
                <span className="text-text-primary">{item.label}</span>
                {item.action === undefined ? null : (
                  <span className="ml-auto">
                    <FirstRunLink target={item.action.target} settingsHref={setup.settingsHref}>
                      {item.action.label}
                    </FirstRunLink>
                  </span>
                )}
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
};
