import { createBooleanDisplayPreference } from './booleanDisplayPreference.js';

/**
 * Whether the model and cost line is shown in answer details. A display preference only: the server
 * records usage either way. Kept in this browser like the color theme, and on unless switched off.
 */
export const MODEL_USAGE_DISPLAY_STORAGE_KEY = 'aman.show_model_usage';

const modelUsageDisplay = createBooleanDisplayPreference({
  storageKey: MODEL_USAGE_DISPLAY_STORAGE_KEY,
  defaultValue: true,
});

export const setModelUsageVisible = modelUsageDisplay.set;

/** The per-user display switch for the model and cost line, and its setter. */
export function useModelUsageVisible(): { visible: boolean; setVisible: (visible: boolean) => void } {
  const visible = modelUsageDisplay.useValue();
  return { visible, setVisible: setModelUsageVisible };
}
