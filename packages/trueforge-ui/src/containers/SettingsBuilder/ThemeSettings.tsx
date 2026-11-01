'use client';

import { cn } from '@/atoms/lib/cn.js';
import { Switch } from '@/atoms/primitives/Switch.js';
import { useTheme } from '@/theme/ThemeProvider.js';
import { PRESETS } from '@/theme/presets/index.js';
import { THEME_PRESET_IDS, type ThemePreset } from '@/theme/types.js';
import { useModelUsageVisible } from '@/utils/modelUsageDisplayPreference.js';

/** Display metadata for each theme preset. The picker order comes from THEME_PRESET_IDS. */
const PRESET_META: Record<ThemePreset, { label: string; description: string }> = {
  paper: { label: 'Paper', description: 'Warm paper, ink and gold' },
  forest: { label: 'Forest', description: 'Calm greens, natural tones' },
  midnight: { label: 'Midnight', description: 'Deep blue-grays, ice blue accents' },
  'high-contrast': { label: 'High contrast', description: 'Maximum legibility, stark surfaces' },
};

/** Small color swatches previewing a preset's key surfaces. */
function PresetSwatches({ preset, mode }: { preset: ThemePreset; mode: 'light' | 'dark' }) {
  const tokens = PRESETS[preset][mode];
  const colors = [tokens.primaryBg, tokens.sidebarBg, tokens.primaryButtonBg, tokens.userMessageBg];
  return (
    <span className="flex overflow-hidden rounded-md border border-border" aria-hidden>
      {colors.map((color, index) => (
        <span key={index} className="h-6 w-6" style={{ backgroundColor: color }} />
      ))}
    </span>
  );
}

const ThemeSettings = () => {
  const { preset, setPreset, mode, preference, setTheme, isDark } = useTheme();
  const { visible: modelUsageVisible, setVisible: setModelUsageVisible } = useModelUsageVisible();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Appearance</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Choose a color theme. Light and dark modes apply on top of the selected theme.
        </p>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-text-primary">Color mode</h3>
        <div className="flex gap-2">
          {(['light', 'dark', 'system'] as const).map(option => (
            <button
              key={option}
              type="button"
              onClick={() => setTheme(option)}
              aria-pressed={preference === option}
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
                preference === option
                  ? 'border-primary-button-bg bg-primary-button-bg text-primary-button-text'
                  : 'border-border bg-secondary-bg text-text-secondary hover:text-text-primary',
              )}
            >
              {option === 'light' ? 'Light' : option === 'dark' ? 'Dark' : 'System'}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-text-primary">Answers</h3>
        <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card-bg p-3">
          <div className="min-w-0">
            <p id="model-usage-display-label" className="text-sm font-medium text-text-primary">
              Show model and cost in answer details
            </p>
            <p id="model-usage-display-hint" className="mt-0.5 text-xs text-text-secondary">
              The model, provider, tokens and cost of each answer, with the helper calls behind it. Hiding it only
              changes what you see here; usage is still counted.
            </p>
          </div>
          <Switch
            checked={modelUsageVisible}
            onCheckedChange={setModelUsageVisible}
            aria-labelledby="model-usage-display-label"
            aria-describedby="model-usage-display-hint"
          />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-text-primary">Theme</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {THEME_PRESET_IDS.map(name => {
            const meta = PRESET_META[name];
            const selected = preset === name;
            return (
              <button
                key={name}
                type="button"
                onClick={() => setPreset(name)}
                aria-pressed={selected}
                className={cn(
                  'flex items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
                  selected
                    ? 'border-primary-button-bg bg-secondary-bg'
                    : 'border-border bg-card-bg hover:border-primary-button-bg/50',
                )}
              >
                <PresetSwatches preset={name} mode={isDark ? 'dark' : 'light'} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-text-primary">{meta.label}</span>
                  <span className="block truncate text-xs text-text-secondary">{meta.description}</span>
                </span>
                {selected ? (
                  <span className="text-xs font-medium text-primary-button-bg" aria-hidden>
                    Active
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-text-secondary">
          Showing {mode} previews. Toggle the color mode above to preview the other variant.
        </p>
      </div>
    </div>
  );
};

export default ThemeSettings;
