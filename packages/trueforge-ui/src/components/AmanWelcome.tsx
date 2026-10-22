'use client';

import type { HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';
import { useEffect, useState } from 'react';

import { WelcomeScreen, type WelcomeScreenProps } from '../atoms/WelcomeScreen.js';
import { Button } from '../atoms/primitives/Button.js';
import { useOptionalCurrentUser } from '../contexts/CurrentUserContext.js';
import { useGrantedGoogleFeatures } from '../hooks/useGrantedGoogleFeatures.js';
import { useSendPrompt } from '../hooks/useSendPrompt.js';
import { useOptionalScheduleServer, useServerCapabilities } from '../server/ServerContext.js';
import { assistantDisplayName } from '../utils/assistantName.js';
import { useTourHidden } from '../utils/tourDisplayPreference.js';
import { AmanFirstRunGuide, AmanFirstRunSummary, FirstRunLink, isFirstRunGuideVisible } from './AmanFirstRunGuide.js';
import { useOptionalAmanPandaSrc } from './AmanPanda.js';
import { useOptionalAmanSetup } from './AmanSetupContext.js';
import { AmanTour, greetingLine } from './AmanTour.js';
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
        /* Keep the last count; the day ticket reads fine without it. */
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

/** The tour's line under "Quietly watching": the setup count while the guide is open, else the name line. */
function TourSetupLine() {
  const setup = useOptionalAmanSetup();
  if (setup !== null && isFirstRunGuideVisible(setup)) {
    return <AmanFirstRunSummary placement="chat" />;
  }
  return <AmanNameLine />;
}

/**
 * The setup block the plain greeting shows: the checklist while the owner has not put it away,
 * else one quiet line while the name is unset. The tour keeps only its compact summary line.
 */
function AmanSetupBlock() {
  const setup = useOptionalAmanSetup();
  if (setup === null) {
    return null;
  }
  if (isFirstRunGuideVisible(setup)) {
    return (
      <div className="mb-6 flex w-full flex-col items-center px-4">
        <AmanFirstRunGuide placement="chat" />
      </div>
    );
  }
  return (
    <div className="mb-6 flex w-full flex-col items-center px-4">
      <AmanNameLine />
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
  const waiting = useTourWaiting();
  const scheduleCount = useScheduleCount();
  const pandaSrc = useOptionalAmanPandaSrc();
  const currentUser = useOptionalCurrentUser();
  const personName = personDisplayName({
    profile: personalization?.profile,
    signInName: currentUser?.displayName,
  });
  const ordinaryChat = props.heading === undefined;

  if (ordinaryChat && !hidden) {
    const profile = personalization?.profile ?? EMPTY_PERSONALIZATION_PROFILE;
    const saveHelpAreas = (next: HelpAreaId[]) => {
      // The chooser reads the saved profile, so a failed save leaves it as it was.
      void personalization?.updateProfile({ ...profile, help_areas: next }).catch(() => {});
    };
    return (
      <AmanTour
        capabilities={capabilities}
        helpAreas={profile.help_areas}
        onHelpAreasChange={saveHelpAreas}
        userName={personName}
        assistantName={profile.assistant_name}
        waiting={waiting}
        scheduleCount={scheduleCount}
        canSend={setup === null || setup.modelName !== null}
        onSend={sendPrompt}
        onHide={() => setHidden(true)}
        setup={<TourSetupLine />}
        pandaSrc={pandaSrc}
      />
    );
  }

  const heading = props.heading ?? <span className="aui-day-title">{amanWelcomeHeading({ name: personName })}</span>;
  return (
    <>
      <WelcomeScreen {...props} heading={heading} />
      <AmanSetupBlock />
      {ordinaryChat ? (
        <div className="mb-6 flex justify-center">
          <Button type="button" variant="ghost" size="small" onClick={() => setHidden(false)}>
            Replay the tour
          </Button>
        </div>
      ) : null}
    </>
  );
}
