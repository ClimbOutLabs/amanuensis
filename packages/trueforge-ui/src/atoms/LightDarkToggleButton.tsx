'use client';

import { Icon } from '../icons/Icon.js';
import { useTheme } from '../theme/ThemeProvider.js';
import { headerActionClassName } from './lib/buttonClasses.js';

// The chat header's light and dark button, beside the Agent details switch. It shows a moon while
// the chat is in light mode and a sun while it is in dark mode, and one tap flips to the other,
// using the same theme state as the Appearance page in Settings. A tap while the choice is Match
// my computer picks the opposite of the mode on screen now, and that picked mode is the choice
// from then on.
export function LightDarkToggleButton() {
  const { mode, setTheme } = useTheme();
  const isDark = mode === 'dark';
  const label = isDark ? 'Switch to light' : 'Switch to dark';

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={headerActionClassName}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      <Icon name={isDark ? 'sun' : 'moon'} />
    </button>
  );
}
