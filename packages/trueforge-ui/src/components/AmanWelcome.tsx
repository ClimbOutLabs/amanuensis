'use client';

import { WelcomeScreen, type WelcomeScreenProps } from '../atoms/WelcomeScreen.js';
import { useOptionalCurrentUser } from '../contexts/CurrentUserContext.js';
import { useGrantedGoogleFeatures } from '../hooks/useGrantedGoogleFeatures.js';
import { useFillPrompt, useSendPrompt } from '../hooks/useSendPrompt.js';
import { useServerCapabilities } from '../server/ServerContext.js';
import { AmanSetupTicket } from './AmanFirstRunGuide.js';
import { useOptionalAmanSetup } from './AmanSetupContext.js';
import { AmanTour } from './AmanTour.js';
import { EMPTY_PERSONALIZATION_PROFILE, useOptionalPersonalization } from './PersonalizationContext.js';
import { personDisplayName } from './personDisplayName.js';
import type { TourCapabilities } from './tourPrompts.js';
import { useDailyBriefRun } from './useDailyBriefRun.js';

/**
 * What this instance can do, read from data the shell already has: the sandbox from server
 * capabilities and the Google grants from the catalog. Unknown reads to "no", so a pill only
 * offers a prompt once the instance has confirmed the capability.
 */
function useTourCapabilities(): TourCapabilities {
  const granted = useGrantedGoogleFeatures();
  const capabilities = useServerCapabilities();
  return {
    email: granted?.includes('gmail_read') === true,
    calendar: granted?.includes('calendar_read') === true,
    sandbox: capabilities?.sandbox.enabled === true,
    // Maps ships built in with public upstreams and has no off switch, so it is on wherever the
    // home runs. It stays a capability so that a future off switch hides its prompts without a change here.
    maps: true,
  };
}

/** The home on an ordinary new chat. The first-run lines show until the first chat, or until Skip. */
function AmanHome() {
  const personalization = useOptionalPersonalization();
  const setup = useOptionalAmanSetup();
  const capabilities = useTourCapabilities();
  const fillPrompt = useFillPrompt();
  const sendPrompt = useSendPrompt();
  const runBrief = useDailyBriefRun();
  const currentUser = useOptionalCurrentUser();
  const profile = personalization?.profile ?? EMPTY_PERSONALIZATION_PROFILE;
  const personName = personDisplayName({
    profile: personalization?.profile,
    signInName: currentUser?.displayName,
  });
  const dismiss = setup?.firstRunGuide?.dismiss;
  const firstRun = setup !== null && setup.hasChatted !== true && setup.firstRunGuide?.dismissed !== true;
  return (
    <AmanTour
      capabilities={capabilities}
      userName={personName}
      assistantName={profile.assistant_name}
      firstRun={firstRun}
      setupTicket={<AmanSetupTicket />}
      onSkip={firstRun ? dismiss : undefined}
      onSend={sendPrompt}
      onFill={fillPrompt}
      canSend={setup === null || setup.modelName !== null}
      {...(runBrief === undefined ? {} : { onRunBrief: runBrief })}
    />
  );
}

/**
 * The welcome screen as Amanuensis presents it on an ordinary new chat. An active agent passes its
 * own heading, and then the agent's plain welcome shows instead of the home.
 */
export function AmanWelcome(props: WelcomeScreenProps) {
  if (props.heading !== undefined) {
    return <WelcomeScreen {...props} />;
  }
  return <AmanHome />;
}
