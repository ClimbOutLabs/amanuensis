import { createBooleanDisplayPreference } from './booleanDisplayPreference.js';

/** Stored as `'true'` once the owner hides the tour; absent means the tour shows. */
export const TOUR_HIDDEN_STORAGE_KEY = 'aman.hide_tour';

const tourDisplay = createBooleanDisplayPreference({ storageKey: TOUR_HIDDEN_STORAGE_KEY, defaultValue: false });

const setTourHidden = tourDisplay.set;

/** Whether the owner has put the tour away on the empty chat, and the setter that brings it back or hides it. */
export function useTourHidden(): { hidden: boolean; setHidden: (hidden: boolean) => void } {
  const hidden = tourDisplay.useValue();
  return { hidden, setHidden: setTourHidden };
}
