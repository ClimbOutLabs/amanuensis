'use client';

import type { HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';
import { useEffect, useState } from 'react';

import { WelcomeScreen, type WelcomeScreenProps } from '../atoms/WelcomeScreen.js';
import { useOptionalCurrentUser } from '../contexts/CurrentUserContext.js';
import { useGrantedGoogleFeatures } from '../hooks/useGrantedGoogleFeatures.js';
import { useSendPrompt } from '../hooks/useSendPrompt.js';
import { useOptionalScheduleServer, useServerCapabilities } from '../server/ServerContext.js';
import { assistantDisplayName } from '../utils/assistantName.js';
import { useTourHidden } from '../utils/tourDisplayPreference.js';
import { AmanFirstRunGuide, AmanFirstRunSummary, FirstRunLink, isFirstRunGuideVisible } from './AmanFirstRunGuide.js';
import { AmanHomeStatus, AmanStarters } from './AmanHome.js';
import { AmanPandaRoundTicket, useOptionalAmanPandaSrc } from './AmanPanda.js';
import { useOptionalAmanSetup } from './AmanSetupContext.js';
import { AmanTour, TOUR_SUBLINE, greetingLine } from './AmanTour.js';
import { useTourWaiting } from './AmanTourWaiting.js';
import { EMPTY_PERSONALIZATION_PROFILE, useOptionalPersonalization } from './PersonalizationContext.js';
import { personDisplayName } from './personDisplayName.js';
import type { TourCapabilities } from './tourPrompts.js';

/** The plain greeting: the time of day, and the person's name when there is one. */
export function amanWelcomeHeading({ name, now = new Date() }: { name: string | undefined; now?: Date }): string {
  return greetingLine({ now, name });
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
    // Maps ships built in with public upstreams and has no off switch, so it is on wherever the
    // Tour runs. It stays a capability so that a future off switch hides its card without a change here.
    maps: true,
  };
}

/**
 * How many scheduled runs the person has set up, read from the first page of the schedules list.
 * A failed read keeps the last count, so the stub never blanks out because the schedules server is slow.
 */
function useScheduleCount(): number {
  const schedules = useOptionalScheduleServer();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (schedules === null) return;
    let cancelled = false;
    schedules
      .listSchedules()
      .then(page => {
        if (!cancelled) setCount(page.data.length);
      })
      .catch(() => {
        /* Keep the last count; the status line reads fine without it. */
      });
    return () => {
      cancelled = true;
    };
  }, [schedules]);
  return count;
}

/**
 * Asks for the owner's name while it is unset. It waits for the profile to load, so it never
 * flashes up for a person who already has one.
 */
function AmanNameLine() {
  const personalization = useOptionalPersonalization();
  const setup = useOptionalAmanSetup();
  const nameMissing =
    personalization !== null && !personalization.loading && !personalization.profile?.user_name?.trim();
  if (setup === null || !nameMissing) {
    return null;
  }
  return (
    <p className="text-center text-sm text-text-secondary" data-testid="aman-name-prompt">
      {assistantDisplayName(personalization?.profile?.assistant_name)} does not know your name yet.{' '}
      <FirstRunLink target={{ kind: 'settings', section: 'personalization' }} settingsHref={setup.settingsHref}>
        Add it in Personalization
      </FirstRunLink>
      .
    </p>
  );
}

/** Under the first-run intro: the setup count while the guide is open, else the name line. */
function TourSetupLine() {
  const setup = useOptionalAmanSetup();
  if (setup !== null && isFirstRunGuideVisible(setup)) {
    return <AmanFirstRunSummary placement="chat" />;
  }
  return <AmanNameLine />;
}

/** Once the tour is hidden, the setup checklist while the owner has not put it away, else the name line. */
function AmanSetupBlock() {
  const setup = useOptionalAmanSetup();
  if (setup === null) {
    return null;
  }
  if (isFirstRunGuideVisible(setup)) {
    return <AmanFirstRunGuide placement="chat" />;
  }
  return <AmanNameLine />;
}

/**
 * The home's top, above the composer: the greeting, then for a first-run person one line about the
 * assistant, the status line, and the setup. An active agent's heading gets the plain greeting only.
 */
export function AmanWelcome(props: WelcomeScreenProps) {
  const personalization = useOptionalPersonalization();
  const setup = useOptionalAmanSetup();
  const { hidden } = useTourHidden();
  const sendPrompt = useSendPrompt();
  const waiting = useTourWaiting();
  const scheduleCount = useScheduleCount();
  const pandaSrc = useOptionalAmanPandaSrc();
  const currentUser = useOptionalCurrentUser();
  const personName = personDisplayName({
    profile: personalization?.profile,
    signInName: currentUser?.displayName,
  });
  const profile = personalization?.profile ?? EMPTY_PERSONALIZATION_PROFILE;
  const assistant = assistantDisplayName(profile.assistant_name);
  const canSend = setup === null || setup.modelName !== null;
  const ordinaryChat = props.heading === undefined;
  const showTour = ordinaryChat && !hidden;

  const greeting = (
    <span className="aui-day-title">
      <span className="aui-underline">{amanWelcomeHeading({ name: personName })}</span>
    </span>
  );
  const phonePanda =
    pandaSrc === null ? undefined : <AmanPandaRoundTicket src={pandaSrc} name={assistant} className="sm:hidden" />;
  const hasTopBlock = ordinaryChat || setup !== null;

  return (
    <>
      <WelcomeScreen {...props} heading={props.heading ?? greeting} icon={ordinaryChat ? phonePanda : props.icon} />
      {hasTopBlock ? (
        <div className="mb-6 flex w-full flex-col items-center gap-3 px-4">
          {showTour ? <p className="m-0 text-center text-sm text-text-secondary">{TOUR_SUBLINE}</p> : null}
          {ordinaryChat ? (
            <AmanHomeStatus
              assistantName={assistant}
              waitingCount={waiting.count}
              scheduleCount={scheduleCount}
              canSend={canSend}
              onSend={sendPrompt}
            />
          ) : null}
          {showTour ? <TourSetupLine /> : <AmanSetupBlock />}
        </div>
      ) : null}
    </>
  );
}

/**
 * What the home shows below the composer: up to three starters from the picked help areas, then
 * the tour panel, or a "Show the tour" link once the owner has hidden it.
 */
export function AmanWelcomeFooter() {
  const personalization = useOptionalPersonalization();
  const setup = useOptionalAmanSetup();
  const { hidden, setHidden } = useTourHidden();
  const capabilities = useTourCapabilities();
  const sendPrompt = useSendPrompt();
  const profile = personalization?.profile ?? EMPTY_PERSONALIZATION_PROFILE;
  const canSend = setup === null || setup.modelName !== null;
  const saveHelpAreas = (next: HelpAreaId[]) => {
    // The chooser reads the saved profile, so a failed save leaves it as it was.
    void personalization?.updateProfile({ ...profile, help_areas: next }).catch(() => {});
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-6 px-4 pb-6 pt-6">
      {canSend ? null : (
        <p className="m-0 text-center text-sm text-text-secondary">
          Choose a model in Settings before you start a chat.
        </p>
      )}
      <AmanStarters helpAreas={profile.help_areas} capabilities={capabilities} canSend={canSend} onSend={sendPrompt} />
      {hidden ? (
        <button
          type="button"
          onClick={() => setHidden(false)}
          className="cursor-pointer border-0 bg-transparent text-sm text-text-secondary underline underline-offset-2"
        >
          Show the tour
        </button>
      ) : (
        <AmanTour
          capabilities={capabilities}
          helpAreas={profile.help_areas}
          onHelpAreasChange={saveHelpAreas}
          assistantName={profile.assistant_name}
          canSend={canSend}
          onSend={sendPrompt}
          onHide={() => setHidden(true)}
        />
      )}
    </div>
  );
}
