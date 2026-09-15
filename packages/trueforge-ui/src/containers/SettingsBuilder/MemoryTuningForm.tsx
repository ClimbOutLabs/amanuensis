/**
 * Per-bank memory tuning, presented under the active bank in Memory settings.
 *
 * Every field is optional and blank means the server-wide default, so the form never shows a
 * value it did not store and the environment stays the single source for anything not set here.
 * Bounds match the API's validation; the draft holds strings so a half-typed number is not lost.
 */
import { Button } from '@/atoms/primitives/Button.js';
import { Tooltip } from '@/atoms/primitives/Tooltip.js';
import { Icon } from '@/icons/Icon.js';
import {
  MEMORY_RECALL_MIN_SCORE_LIMITS,
  MEMORY_SETTINGS_LIMITS,
  type MemoryProviderSettings,
  REFLECT_BUDGETS,
} from '@/server/memoryProviderTypes.js';
import type { MemoryDefaults } from './memoryDefaultsCapability.js';
import { isReflectBudget } from './memoryProvider.js';

type NumberKey =
  | 'recallTimeoutMs'
  | 'recallQueryWindow'
  | 'recallMinScore'
  | 'recallMaxItems'
  | 'recallMaxEntities'
  | 'curatedMaxModels'
  | 'curatedMaxTokens'
  | 'reflectMaxTokens'
  | 'reflectTimeoutMs';
type ToggleKey = 'curatedEnabled' | 'reflectEnabled';
type TuningKey = NumberKey | ToggleKey | 'reflectBudget';

export type MemoryTuningDraft = Record<TuningKey, string>;

interface NumberField {
  key: NumberKey;
  kind: 'number';
  label: string;
  min: number;
  max: number;
  step: number;
  /** False only for `recallMinScore`, the one field bounded to a fraction. Defaults to true. */
  isInteger?: boolean;
  help: string;
}
interface ToggleField {
  key: ToggleKey;
  kind: 'toggle';
  label: string;
  help: string;
}
interface BudgetField {
  key: 'reflectBudget';
  kind: 'budget';
  label: string;
  help: string;
}
type TuningField = NumberField | ToggleField | BudgetField;

const FIELDS: readonly TuningField[] = [
  {
    key: 'recallTimeoutMs',
    kind: 'number',
    label: 'Recall timeout (milliseconds)',
    ...MEMORY_SETTINGS_LIMITS.recallTimeoutMs,
    step: 500,
    help: 'How long a turn waits for recalled memory before continuing without it. Large banks search slower.',
  },
  {
    key: 'recallQueryWindow',
    kind: 'number',
    label: 'Recall query window (messages)',
    ...MEMORY_SETTINGS_LIMITS.recallQueryWindow,
    step: 1,
    help: 'How many recent messages form the recall query, so a short follow-up keeps its question.',
  },
  {
    key: 'recallMinScore',
    kind: 'number',
    label: 'Recall relevance floor',
    ...MEMORY_RECALL_MIN_SCORE_LIMITS,
    step: 0.05,
    isInteger: false,
    help:
      'A recalled item or entity summary scored below this is dropped, when the response carries a provider score. ' +
      'Ignored for a response with no scores.',
  },
  {
    key: 'recallMaxItems',
    kind: 'number',
    label: 'Recalled items kept',
    ...MEMORY_SETTINGS_LIMITS.recallMaxItems,
    step: 1,
    help: 'Most recalled items kept, by provider rank, when the response carries no per-item score.',
  },
  {
    key: 'recallMaxEntities',
    kind: 'number',
    label: 'Entity summaries kept',
    ...MEMORY_SETTINGS_LIMITS.recallMaxEntities,
    step: 1,
    help: 'Most entity summaries kept, by provider rank, when the response carries no per-entity score.',
  },
  {
    key: 'curatedEnabled',
    kind: 'toggle',
    label: 'Curated layer',
    help: 'Inject the bank profile and the mental models that match the question on every turn.',
  },
  {
    key: 'curatedMaxModels',
    kind: 'number',
    label: 'Mental models per turn',
    ...MEMORY_SETTINGS_LIMITS.curatedMaxModels,
    step: 1,
    help: 'How many matching mental models are injected on each turn.',
  },
  {
    key: 'curatedMaxTokens',
    kind: 'number',
    label: 'Mental model token budget',
    ...MEMORY_SETTINGS_LIMITS.curatedMaxTokens,
    step: 64,
    help: 'Total tokens the injected mental models may use on each turn.',
  },
  {
    key: 'reflectEnabled',
    kind: 'toggle',
    label: 'Reflect layer',
    help: 'Ask the bank to reflect when the question asks for a summary, briefing, recommendation or comparison. Spends model calls.',
  },
  {
    key: 'reflectBudget',
    kind: 'budget',
    label: 'Reflect effort',
    help: 'How much effort a reflection may spend: low, mid, or high.',
  },
  {
    key: 'reflectMaxTokens',
    kind: 'number',
    label: 'Reflect answer token cap',
    ...MEMORY_SETTINGS_LIMITS.reflectMaxTokens,
    step: 64,
    help: 'Token cap for a single reflection answer.',
  },
  {
    key: 'reflectTimeoutMs',
    kind: 'number',
    label: 'Reflect timeout (milliseconds)',
    ...MEMORY_SETTINGS_LIMITS.reflectTimeoutMs,
    step: 500,
    help: 'How long a turn waits for a reflection before continuing without it.',
  },
];

const EMPTY_DRAFT: MemoryTuningDraft = {
  recallTimeoutMs: '',
  recallQueryWindow: '',
  recallMinScore: '',
  recallMaxItems: '',
  recallMaxEntities: '',
  curatedEnabled: '',
  curatedMaxModels: '',
  curatedMaxTokens: '',
  reflectEnabled: '',
  reflectBudget: '',
  reflectMaxTokens: '',
  reflectTimeoutMs: '',
};

function toggleText(value: boolean | undefined): string {
  if (value === undefined) return '';
  return value ? 'on' : 'off';
}

export function draftFromSettings(settings: MemoryProviderSettings | undefined): MemoryTuningDraft {
  if (settings === undefined) return { ...EMPTY_DRAFT };
  return {
    recallTimeoutMs: settings.recallTimeoutMs?.toString() ?? '',
    recallQueryWindow: settings.recallQueryWindow?.toString() ?? '',
    recallMinScore: settings.recallMinScore?.toString() ?? '',
    recallMaxItems: settings.recallMaxItems?.toString() ?? '',
    recallMaxEntities: settings.recallMaxEntities?.toString() ?? '',
    curatedEnabled: toggleText(settings.curatedEnabled),
    curatedMaxModels: settings.curatedMaxModels?.toString() ?? '',
    curatedMaxTokens: settings.curatedMaxTokens?.toString() ?? '',
    reflectEnabled: toggleText(settings.reflectEnabled),
    reflectBudget: settings.reflectBudget ?? '',
    reflectMaxTokens: settings.reflectMaxTokens?.toString() ?? '',
    reflectTimeoutMs: settings.reflectTimeoutMs?.toString() ?? '',
  };
}

/** Validates the draft the way the API will, so a rejected value is explained before any write. */
export function settingsFromDraft(
  draft: MemoryTuningDraft,
): { ok: true; settings: MemoryProviderSettings | undefined } | { ok: false; error: string } {
  const numbers: Partial<Record<NumberKey, number>> = {};
  const toggles: Partial<Record<ToggleKey, boolean>> = {};
  let budget: MemoryProviderSettings['reflectBudget'];
  for (const field of FIELDS) {
    const raw = draft[field.key].trim();
    if (raw === '') continue;
    if (field.kind === 'number') {
      const value = Number(raw);
      const requireInteger = field.isInteger !== false;
      if (
        Number.isNaN(value) ||
        (requireInteger && !Number.isInteger(value)) ||
        value < field.min ||
        value > field.max
      ) {
        const kind = requireInteger ? 'a whole number' : 'a number';
        return {
          ok: false,
          error: `${field.label}: enter ${kind} from ${field.min.toLocaleString()} to ${field.max.toLocaleString()}.`,
        };
      }
      numbers[field.key] = value;
    } else if (field.kind === 'toggle') {
      toggles[field.key] = raw === 'on';
    } else if (isReflectBudget(raw)) {
      budget = raw;
    }
  }
  const settings: MemoryProviderSettings = {
    ...numbers,
    ...toggles,
    ...(budget === undefined ? {} : { reflectBudget: budget }),
  };
  return { ok: true, settings: Object.keys(settings).length > 0 ? settings : undefined };
}

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-border bg-primary-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus:border-primary-button-bg';

/**
 * `defaults` only ever carries the fields `memory_defaults` resolves (see {@link MemoryDefaults}):
 * `recallMinScore`, `recallMaxItems`, and `recallMaxEntities` are never among them, so this is a
 * runtime guard, not a cast, that narrows `field.key` to a key `defaults` actually has before it
 * is indexed.
 */
function hasDefault(defaults: MemoryDefaults, key: TuningKey): key is TuningKey & keyof MemoryDefaults {
  return key in defaults;
}

/** The words a blank field shows: the server's actual value when known, so nobody has to guess it. */
function defaultLabel(field: TuningField, defaults: MemoryDefaults | null): string {
  if (defaults === null || !hasDefault(defaults, field.key)) return 'Server default';
  if (field.kind === 'number') return String(defaults[field.key]);
  if (field.kind === 'toggle') return `Server default (${defaults[field.key] ? 'on' : 'off'})`;
  return `Server default (${defaults.reflectBudget})`;
}

const MemoryTuningForm = (props: {
  draft: MemoryTuningDraft;
  busy: boolean;
  error: string | null;
  /** The server-wide defaults, when the capabilities read carried them; null shows the plain words. */
  defaults: MemoryDefaults | null;
  onChange: (next: MemoryTuningDraft) => void;
  onSave: () => void;
}) => {
  const { draft, busy, error, defaults, onChange, onSave } = props;
  const set = (key: TuningKey, value: string) => {
    onChange({ ...draft, [key]: value });
  };
  return (
    <div className="mt-4 border-t border-border pt-4">
      <h3 className="text-sm font-medium text-text-primary">Memory tuning</h3>
      <p className="mt-1 text-xs text-text-secondary">
        Per-bank settings for how this host recalls from it. A blank field keeps the server default shown in it. What
        each turn actually used is recorded on that turn's recall event.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {FIELDS.map(field => {
          const inputId = `memory-tuning-${field.key}`;
          return (
            <div key={field.key}>
              <div className="flex items-center gap-1.5">
                <label htmlFor={inputId} className="text-sm text-text-primary">
                  {field.label}
                </label>
                <Tooltip content={field.help} className="max-w-64 whitespace-normal">
                  <button
                    type="button"
                    aria-label={`${field.label}: more info`}
                    className="inline-flex text-text-secondary transition-colors hover:text-text-primary"
                  >
                    <Icon name="info" className="size-3.5" />
                  </button>
                </Tooltip>
              </div>
              {field.kind === 'number' ? (
                <input
                  id={inputId}
                  className={INPUT_CLASS}
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={draft[field.key]}
                  placeholder={defaultLabel(field, defaults)}
                  disabled={busy}
                  onChange={event => {
                    set(field.key, event.target.value);
                  }}
                />
              ) : (
                <select
                  id={inputId}
                  className={INPUT_CLASS}
                  value={draft[field.key]}
                  disabled={busy}
                  onChange={event => {
                    set(field.key, event.target.value);
                  }}
                >
                  <option value="">{defaultLabel(field, defaults)}</option>
                  {field.kind === 'toggle' ? (
                    <>
                      <option value="on">On</option>
                      <option value="off">Off</option>
                    </>
                  ) : (
                    REFLECT_BUDGETS.map(value => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))
                  )}
                </select>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="secondary" size="small" type="button" disabled={busy} onClick={onSave}>
          Save tuning
        </Button>
        {error ? (
          <p className="text-xs text-failure-bg" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
};

export default MemoryTuningForm;
