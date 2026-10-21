'use client';

import { useAui } from '@assistant-ui/react';
import { useCallback } from 'react';

import { WelcomeScreen, type WelcomeScreenProps } from '../atoms/WelcomeScreen.js';
import { Button } from '../atoms/primitives/Button.js';
import { useOptionalComposerBusyState } from '../hooks/useComposerBusyState.js';
import { useGrantedGoogleFeatures } from '../hooks/useGrantedGoogleFeatures.js';
import { useServerCapabilities } from '../server/ServerContext.js';
import { useTourHidden } from '../utils/tourDisplayPreference.js';
import {
  AmanFirstRunGuide,
  FirstRunLink,
  isFirstRunGuideVisible,
  isFirstRunSetupComplete,
} from './AmanFirstRunGuide.js';
import { useOptionalAmanSetup } from './AmanSetupContext.js';
import { AmanTour, type TourCapabilities } from './AmanTour.js';
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

/**
 * What this instance can do, read from data the shell already has: the sandbox from server
 * capabilities and the Google grants from the catalog. Unknown reads to "no", so a prompt only
 * shows once the instance has confirmed the capability.
 */
function useTourCapabilities(): TourCapabilities {
  const granted = useGrantedGoogleFeatures();
  const capabilities = useServerCapabilities();
  return {
    email: granted?.includes('gmail_read') === true,
    calendar: granted?.includes('calendar_read') === true,
    sandbox: capabilities?.sandbox.enabled === true,
  };
}

/** Puts a prompt in the composer and sends it, through the same busy-state wrapper the send button uses. */
function useSendPrompt(): (prompt: string) => void {
  const aui = useAui();
  const busy = useOptionalComposerBusyState();
  return useCallback(
    (prompt: string) => {
      aui.composer().setText(prompt);
      const send = () => aui.composer().send();
      if (busy === null) {
        send();
      } else {
        busy.send(send);
      }
    },
    [aui, busy],
  );
}

/**
 * The setup block both welcome screens share: the checklist while the owner has not put it away,
 * else one quiet line while the name is unset. The tour drops the checklist once every line is done.
 */
function AmanSetupBlock({ hideWhenComplete }: { hideWhenComplete: boolean }) {
  const personalization = useOptionalPersonalization();
  const setup = useOptionalAmanSetup();
  if (setup === null) {
    return null;
  }
  const userName = personalization?.profile?.user_name;
  const complete = isFirstRunSetupComplete({
    modelName: setup.modelName,
    userName,
    hasChatted: setup.hasChatted,
    placement: 'chat',
  });
  const showGuide = isFirstRunGuideVisible(setup) && !(hideWhenComplete && complete);
  if (showGuide) {
    return (
      <div className="mb-6 flex w-full flex-col items-center px-4">
        <AmanFirstRunGuide placement="chat" hideWhenComplete={hideWhenComplete} />
      </div>
    );
  }
  // The profile is still on its way: the name line waits for it rather than flashing up.
  const nameMissing = personalization !== null && !personalization.loading && !userName?.trim();
  if (!nameMissing) {
    return null;
  }
  return (
    <div className="mb-6 flex w-full flex-col items-center px-4">
      <p className="text-center text-sm text-text-secondary" data-testid="aman-name-prompt">
        Aman does not know your name yet.{' '}
        <FirstRunLink target={{ kind: 'settings', section: 'personalization' }} settingsHref={setup.settingsHref}>
          Add it in Personalization
        </FirstRunLink>
        .
      </p>
    </div>
  );
}

/**
 * The welcome screen as Amanuensis presents it on an ordinary new chat: the tour, with setup
 * folded in at the top. Once the owner hides the tour, or when the runtime passes a heading
 * (an active agent's name), the plain greeting and setup block show instead.
 */
export function AmanWelcome(props: WelcomeScreenProps) {
  const personalization = useOptionalPersonalization();
  const setup = useOptionalAmanSetup();
  const { hidden, setHidden } = useTourHidden();
  const capabilities = useTourCapabilities();
  const sendPrompt = useSendPrompt();
  const ordinaryChat = props.heading === undefined;

  if (ordinaryChat && !hidden) {
    return (
      <AmanTour
        capabilities={capabilities}
        canSend={setup === null || setup.modelName !== null}
        onSend={sendPrompt}
        onHide={() => setHidden(true)}
        setup={<AmanSetupBlock hideWhenComplete />}
      />
    );
  }

  const heading = props.heading ?? amanWelcomeHeading(personalization?.profile?.assistant_name);
  return (
    <>
      <WelcomeScreen {...props} heading={heading} />
      <AmanSetupBlock hideWhenComplete={false} />
      {ordinaryChat ? (
        <div className="mb-6 flex justify-center">
          <Button type="button" variant="ghost" size="small" onClick={() => setHidden(false)}>
            Show the tour
          </Button>
        </div>
      ) : null}
    </>
  );
}
