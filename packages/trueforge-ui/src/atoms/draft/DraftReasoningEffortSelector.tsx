'use client';

import { useTrueFoundryAgentSpec, useTrueFoundryUpdateAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useRef } from 'react';

import { cn } from '../lib/cn.js';
import { useDraftCatalog } from './DraftCatalogProvider.js';
import { hasReasoningEfforts, modelPatchWithReasoningEffort, resolveReasoningEffort } from './reasoningEffort.js';

export type ReasoningEffortChoices = {
  efforts: string[];
  /** The effort in use, falling back to the model's first when the stored one is not offered. */
  resolved: string;
  choose: (effort: string) => void;
};

/**
 * The effort choices for the selected model, or null when it offers none. Also heals a stored
 * effort the model does not support, so that effort is never sent.
 */
export function useReasoningEffortChoices(): ReasoningEffortChoices | null {
  const { models, ensureLoaded } = useDraftCatalog();
  const { agentSpec } = useTrueFoundryAgentSpec();
  const updateAgentSpec = useTrueFoundryUpdateAgentSpec();
  const clearedStickyEffortForModelRef = useRef<string | null>(null);

  const selectedName = agentSpec?.model?.name ?? models[0]?.name ?? '';
  const selected = models.find(m => m.name === selectedName);
  const efforts = selected?.properties.reasoningEfforts;
  const currentEffort = agentSpec?.model?.params?.reasoningEffort;
  // Display fallback only — coerce into the spec on model change / explicit pick.
  const resolved = resolveReasoningEffort(efforts, currentEffort);

  useEffect(() => {
    // Need catalog to know whether this model exposes reasoning efforts.
    ensureLoaded();
  }, [ensureLoaded]);

  // Heal a sticky/unsupported effort left by mergeAgentSpec: on load and on model
  // switch, clamp to the resolved value whenever the current effort is not one
  // this model supports (covers both "model has no efforts" and "model has efforts
  // but not this one" — the latter previously stayed unclamped and could still be
  // sent, causing "Unexpected reasoning effort" 400s).
  const healKey = `${selected?.name ?? ''}::${currentEffort ?? ''}`;
  useEffect(() => {
    if (!updateAgentSpec || selected === undefined) return;
    if (currentEffort === resolved) {
      clearedStickyEffortForModelRef.current = null;
      return;
    }
    if (clearedStickyEffortForModelRef.current === healKey) return;
    clearedStickyEffortForModelRef.current = healKey;
    updateAgentSpec({
      model: modelPatchWithReasoningEffort(selected.name, agentSpec?.model?.params, efforts),
    });
  }, [updateAgentSpec, selected, efforts, currentEffort, resolved, healKey, agentSpec?.model?.params]);

  if (!hasReasoningEfforts(efforts) || !resolved || selected === undefined) return null;

  return {
    efforts,
    resolved,
    choose: effort => {
      updateAgentSpec?.({
        model: modelPatchWithReasoningEffort(
          selected.name,
          { ...agentSpec?.model?.params, reasoningEffort: effort },
          efforts,
        ),
      });
    },
  };
}

/** The effort list shown under the model catalog in the model menu. */
export function DraftReasoningEffortOptions({ choices }: { choices: ReasoningEffortChoices }) {
  return (
    <div role="listbox" aria-label="Reasoning effort" className="border-border border-t p-1">
      <p className="text-text-secondary px-2 py-1.5 text-[0.75rem]">Reasoning effort</p>
      {choices.efforts.map(effort => {
        const active = effort === choices.resolved;
        return (
          <button
            key={effort}
            type="button"
            role="option"
            aria-selected={active}
            className={cn(
              'flex w-full items-center rounded-md px-2 py-1.5 text-left text-[0.8125rem]',
              active ? 'bg-dropdown-selected-item-bg text-dropdown-selected-item-text' : 'hover:bg-ghost-button-hover',
            )}
            onClick={() => choices.choose(effort)}
          >
            <span className="truncate">{effort}</span>
          </button>
        );
      })}
    </div>
  );
}
