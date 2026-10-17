'use client';

import { WelcomeScreen, type WelcomeScreenProps } from '../atoms/WelcomeScreen.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { useOptionalAmanSetup, type MemoryBankStatus } from './AmanSetupContext.js';
import { useOptionalPersonalization } from './PersonalizationContext.js';

const DEFAULT_HEADING = 'How can I help you today?';

/**
 * An assistant without a chosen name gets the plain question rather than introducing itself as
 * Amanuensis: the rail already carries the product name, and a greeting should only claim a name
 * the user picked.
 */
export function amanWelcomeHeading(assistantName: string | null | undefined): string {
  const name = assistantName?.trim();
  return name ? `Hi, I'm ${name}. What's on your mind?` : DEFAULT_HEADING;
}

type SetupItem = { key: 'model' | 'memory'; text: string; action: string };

/** Only what is still unset. An empty list means the checklist does not render at all. */
export function amanSetupItems(setup: {
  modelName: string | null;
  memoryBank: MemoryBankStatus | null | undefined;
}): SetupItem[] {
  const items: SetupItem[] = [];
  if (setup.modelName === null || setup.modelName.trim() === '') {
    items.push({ key: 'model', text: 'No model chosen yet.', action: 'Choose a model in Settings › Models' });
  }
  if (setup.memoryBank === null) {
    items.push({
      key: 'memory',
      text: 'Memory is off, so nothing carries over between chats.',
      action: 'Connect a memory bank in Settings › Memory',
    });
  } else if (setup.memoryBank !== undefined && !setup.memoryBank.connected) {
    items.push({
      key: 'memory',
      text: `Memory bank ${setup.memoryBank.name} needs sign-in before it can recall anything.`,
      action: 'Sign in under Settings › Memory',
    });
  }
  return items;
}

/**
 * The welcome screen as Amanuensis presents it: the same slot the runtime renders on an empty
 * chat, with the greeting in the assistant's name and, while a model or memory bank is still
 * unset, a short list of what to set and where. The list disappears once setup is complete; a
 * chat can start before that, since only the model is needed to talk.
 *
 * A shell-mode heading (an active agent's name) passed by the runtime still wins, so this only
 * changes the ordinary new-chat screen.
 */
export function AmanWelcome(props: WelcomeScreenProps) {
  const profile = useOptionalPersonalization()?.profile;
  const setup = useOptionalAmanSetup();
  const shell = useOptionalShellMode();
  const heading = props.heading ?? amanWelcomeHeading(profile?.assistant_name);
  const items = setup === null ? [] : amanSetupItems(setup);
  return (
    <>
      <WelcomeScreen {...props} heading={heading} />
      {items.length > 0 ? (
        <ul
          aria-label="Finish setting up"
          data-testid="aman-setup-checklist"
          className="mb-6 flex w-full max-w-xl flex-col gap-2 self-center px-4 text-sm text-text-secondary"
        >
          {items.map(item => (
            <li
              key={item.key}
              className="flex flex-wrap items-baseline gap-x-2 rounded-lg border border-border bg-card-bg px-3 py-2"
            >
              <span>{item.text}</span>
              {item.key === 'memory' && shell !== null ? (
                // Memory setup lives on the Settings sub-tab of the Memory section; open it
                // directly rather than sending the user to the settings landing page.
                <button
                  type="button"
                  className="text-text-primary underline underline-offset-2"
                  onClick={() => shell.setSettingsOpen(true, 'memory', 'settings')}
                >
                  {item.action}
                </button>
              ) : setup?.settingsHref === undefined ? (
                <span className="text-text-primary">{item.action}</span>
              ) : (
                <a className="text-text-primary underline underline-offset-2" href={setup.settingsHref}>
                  {item.action}
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
