'use client';

import type { FC, ReactNode } from 'react';

import { Button } from '../atoms/primitives/Button.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalShellMode, type SettingsMemoryTab, type SettingsSection } from '../server/ShellModeContext.js';
import { useOptionalAmanSetup, type AmanSetupState, type MemoryBankStatus } from './AmanSetupContext.js';
import { useOptionalPersonalization } from './PersonalizationContext.js';

/** Where a checklist line sends the user: a Settings section, or back to the chat. */
export type FirstRunTarget =
  { kind: 'settings'; section: SettingsSection; memoryTab?: SettingsMemoryTab } | { kind: 'chat' };

export type FirstRunItem = {
  key: 'model' | 'about-you' | 'first-chat' | 'memory';
  label: string;
  detail: string;
  done: boolean;
  /** Left out when there is nothing to click: the line already says what to do. */
  action?: { label: string; target: FirstRunTarget };
};

/** Where the card is showing; the chat already has the composer, so "try a chat" needs no link there. */
export type FirstRunPlacement = 'chat' | 'settings';

function hasText(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim() !== '';
}

/**
 * The checklist, computed from real state so it ticks itself off. Memory is optional and only
 * listed when the host could find out about it; the first chat is listed only when the host
 * knows whether one happened.
 */
export function amanFirstRunItems(input: {
  modelName: string | null;
  /** The personalization profile's user name; undefined while the profile is still loading. */
  userName: string | null | undefined;
  hasChatted: boolean | undefined;
  memoryBank: MemoryBankStatus | null | undefined;
  placement: FirstRunPlacement;
}): FirstRunItem[] {
  const items: FirstRunItem[] = [];
  const { modelName, userName } = input;
  const hasModel = hasText(modelName);
  items.push({
    key: 'model',
    label: 'Add a model',
    detail: hasModel ? `Using ${modelName.trim()}.` : 'Aman needs one model before it can answer.',
    done: hasModel,
    action: { label: 'Choose a model', target: { kind: 'settings', section: 'models' } },
  });
  const hasName = hasText(userName);
  items.push({
    key: 'about-you',
    label: 'Tell Aman about you',
    detail: hasName ? `Aman knows you as ${userName.trim()}.` : 'Your name, and how you would like to be addressed.',
    done: hasName,
    action: { label: 'Open Personalization', target: { kind: 'settings', section: 'personalization' } },
  });
  if (input.hasChatted !== undefined) {
    items.push({
      key: 'first-chat',
      label: 'Try your first chat',
      detail: input.hasChatted ? 'You have started one already.' : 'Ask anything, in your own words.',
      done: input.hasChatted,
      ...(input.placement === 'settings' ? { action: { label: 'Back to chat', target: { kind: 'chat' } } } : {}),
    });
  }
  if (input.memoryBank !== undefined) {
    const bank = input.memoryBank;
    items.push({
      key: 'memory',
      label: 'Connect a memory bank (optional)',
      detail:
        bank === null
          ? 'Memory is off, so nothing carries over between chats.'
          : bank.connected
            ? `${bank.name} is on.`
            : `${bank.name} needs sign-in before it can recall anything.`,
      done: bank?.connected === true,
      action: {
        label: bank === null || bank.connected ? 'Open Memory' : 'Sign in',
        // Memory setup lives on the Settings sub-tab of the Memory section, not its landing tab.
        target: { kind: 'settings', section: 'memory', memoryTab: 'settings' },
      },
    });
  }
  return items;
}

/** Whether the card is on screen: the host either has not wired dismissal, or the owner has not used it. */
export function isFirstRunGuideVisible(setup: AmanSetupState | null): boolean {
  return setup !== null && setup.firstRunGuide?.dismissed !== true;
}

/**
 * A checklist link. Inside the shell it opens the section in place; outside it falls back to the
 * host's settings URL, and with neither it is plain text, so the line still says where to go.
 */
export const FirstRunLink: FC<{ target: FirstRunTarget; settingsHref: string | undefined; children: ReactNode }> = ({
  target,
  settingsHref,
  children,
}) => {
  const shell = useOptionalShellMode();
  const className = 'text-text-primary underline underline-offset-2 hover:text-primary-button-bg';
  if (shell !== null) {
    return (
      <button
        type="button"
        className={className}
        onClick={() => {
          if (target.kind === 'settings') {
            shell.setSettingsOpen(true, target.section, target.memoryTab);
          } else {
            shell.setSettingsOpen(false);
          }
        }}
      >
        {children}
      </button>
    );
  }
  if (target.kind === 'settings' && settingsHref !== undefined) {
    return (
      <a className={className} href={settingsHref}>
        {children}
      </a>
    );
  }
  return <span className="text-text-primary">{children}</span>;
};

/**
 * The first-run card: what to set up and where, ticking itself off from real state. It renders
 * only inside an `AmanSetupProvider`, hides once the owner dismisses it, and never nags again:
 * the dismissal lives on the server, not in this browser.
 */
export const AmanFirstRunGuide: FC<{ placement: FirstRunPlacement; className?: string }> = ({
  placement,
  className,
}) => {
  const setup = useOptionalAmanSetup();
  const personalization = useOptionalPersonalization();
  if (!isFirstRunGuideVisible(setup) || setup === null) {
    return null;
  }
  // The profile is still on its way: a card that ticks "about you" a moment later would flicker.
  if (personalization !== null && personalization.loading) {
    return null;
  }
  const items = amanFirstRunItems({
    modelName: setup.modelName,
    userName: personalization?.profile?.user_name,
    hasChatted: setup.hasChatted,
    memoryBank: setup.memoryBank,
    placement,
  });
  const doneCount = items.filter(item => item.done).length;
  const allDone = doneCount === items.length;
  const dismiss = setup.firstRunGuide?.dismiss;
  return (
    <section
      aria-labelledby="aman-first-run-heading"
      data-testid="aman-first-run-guide"
      data-placement={placement}
      className={`w-full max-w-xl rounded-xl border border-border bg-card-bg p-4 text-left text-text-primary ${className ?? ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="aman-first-run-heading" className="text-base font-semibold tracking-tight">
            {allDone ? 'You are all set' : 'Welcome to Aman'}
          </h2>
          <p className="mt-0.5 text-sm text-text-secondary" data-testid="aman-first-run-progress">
            {allDone
              ? 'Everything on this list is done. You can put it away.'
              : `${doneCount} of ${items.length} done. A few minutes now makes every chat better.`}
          </p>
        </div>
        {dismiss === undefined ? null : (
          <Button type="button" variant="ghost" size="small" className="shrink-0" onClick={dismiss}>
            Dismiss
          </Button>
        )}
      </div>
      <ol className="mt-3 flex list-none flex-col gap-2 p-0" aria-label="Setup checklist">
        {items.map(item => (
          <li
            key={item.key}
            data-done={item.done}
            className="flex items-start gap-3 rounded-lg border border-border/70 bg-secondary-bg px-3 py-2"
          >
            {item.done ? (
              <Icon name="circle-check" className="mt-0.5 size-4 shrink-0 text-success-bg" aria-hidden="true" />
            ) : (
              <span
                className="mt-0.5 inline-block size-4 shrink-0 rounded-full border-2 border-border"
                aria-hidden="true"
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                <span className="sr-only">{item.done ? 'Done: ' : 'To do: '}</span>
                {item.label}
              </p>
              <p className="text-sm text-text-secondary">
                {item.detail}
                {item.done || item.action === undefined ? null : (
                  <>
                    {' '}
                    <FirstRunLink target={item.action.target} settingsHref={setup.settingsHref}>
                      {item.action.label}
                    </FirstRunLink>
                  </>
                )}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
};
