'use client';

import { Icon } from '../icons/Icon.js';
import { useHandsFree } from '../voice/HandsFreeContext.js';
import { useVoiceSettings } from '../voice/VoiceSettingsContext.js';
import { auiButtonClass, sidebarRailButtonClassName } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';

/**
 * Hands-free conversation toggle for the app header / rail. When on, new
 * assistant replies are read aloud and the mic reopens after each reply for
 * a continuous conversation loop. Hidden where the browser has no speech
 * support. Clicking the composer mic button or pressing Escape exits.
 */
export function HandsFreeToggle({ labeled = false }: { labeled?: boolean }) {
  const handsFree = useHandsFree();
  const { speechRecognitionSupported, speechSynthesisSupported } = useVoiceSettings();

  if (!speechRecognitionSupported || !speechSynthesisSupported) return null;

  const hoverClass = 'hover:bg-secondary-button-hover hover:text-ghost-button-text';

  return (
    <button
      type="button"
      aria-label={handsFree.active ? 'Turn hands-free off' : 'Turn hands-free on'}
      aria-pressed={handsFree.active}
      title={
        handsFree.active
          ? 'Hands-free is on: replies are read aloud and the mic keeps listening'
          : 'Hands-free: read replies aloud and keep the mic open for a continuous conversation'
      }
      onClick={() => handsFree.setActive(!handsFree.active)}
      className={auiButtonClass({
        variant: 'ghost',
        size: labeled ? undefined : 'icon',
        className: cn(
          hoverClass,
          labeled && sidebarRailButtonClassName,
          handsFree.active &&
            'bg-primary-button-bg font-medium text-primary-button-text hover:bg-primary-button-hover hover:text-primary-button-text',
          handsFree.active && !labeled && 'relative',
        ),
      })}
    >
      <Icon name="audio-lines" size={labeled ? 14 : undefined} />
      {labeled ? <span className="text-center">Hands-free</span> : null}
      {handsFree.active && !labeled ? (
        <span aria-hidden className="bg-success-bg absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full" />
      ) : null}
    </button>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    HandsFreeToggle: typeof HandsFreeToggle;
  }
}
