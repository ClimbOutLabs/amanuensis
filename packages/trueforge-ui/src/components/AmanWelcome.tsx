'use client';

import { WelcomeScreen, type WelcomeScreenProps } from '../atoms/WelcomeScreen.js';
import { AmanFirstRunGuide, FirstRunLink, isFirstRunGuideVisible } from './AmanFirstRunGuide.js';
import { useOptionalAmanSetup } from './AmanSetupContext.js';
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
 * The welcome screen as Amanuensis presents it: the same slot the runtime renders on an empty
 * chat, with the greeting in the assistant's name and, until the owner puts it away, the
 * first-run checklist. Once the checklist is gone, an owner who still has not given their name
 * sees one quiet line pointing at Personalization; nothing here asks the model to ask.
 *
 * A shell-mode heading (an active agent's name) passed by the runtime still wins, so this only
 * changes the ordinary new-chat screen.
 */
export function AmanWelcome(props: WelcomeScreenProps) {
  const personalization = useOptionalPersonalization();
  const profile = personalization?.profile;
  const setup = useOptionalAmanSetup();
  const heading = props.heading ?? amanWelcomeHeading(profile?.assistant_name);
  const guideVisible = isFirstRunGuideVisible(setup);
  const nameMissing =
    setup !== null && personalization !== null && !personalization.loading && !profile?.user_name?.trim();
  return (
    <>
      <WelcomeScreen {...props} heading={heading} />
      {setup === null ? null : (
        <div className="mb-6 flex w-full flex-col items-center px-4">
          {guideVisible ? (
            <AmanFirstRunGuide placement="chat" />
          ) : nameMissing ? (
            <p className="text-center text-sm text-text-secondary" data-testid="aman-name-prompt">
              Aman does not know your name yet.{' '}
              <FirstRunLink target={{ kind: 'settings', section: 'personalization' }} settingsHref={setup.settingsHref}>
                Add it in Personalization
              </FirstRunLink>
              .
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}
