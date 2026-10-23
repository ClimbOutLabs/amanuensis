'use client';

import { useTrueFoundryAgentSpec, useTrueFoundryUpdateAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useId, useRef, useState } from 'react';

import { Icon } from '../../icons/Icon.js';
import { auiButtonClass } from '../lib/buttonClasses.js';
import { cn } from '../lib/cn.js';
import { useCompactLayout } from '../lib/CompactLayoutContext.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { BottomSheet } from '../primitives/BottomSheet.js';
import { useDraftCatalog } from './DraftCatalogProvider.js';
import { hasReasoningEfforts, modelPatchWithReasoningEffort, resolveReasoningEffort } from './reasoningEffort.js';

export type DraftReasoningEffortSelectorProps = {
  disabled?: boolean;
  isRunning?: boolean;
};

/**
 * Reasoning effort for the selected draft model, with the heal and pick logic shared by
 * the standalone selector and the model menu. Must stay mounted while the composer is.
 */
export function useReasoningEffortState() {
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

  const pick = (effort: string) => {
    if (!selected || !updateAgentSpec || !efforts) return;
    updateAgentSpec({
      model: modelPatchWithReasoningEffort(
        selected.name,
        { ...agentSpec?.model?.params, reasoningEffort: effort },
        efforts,
      ),
    });
  };

  return { efforts, resolved, pick };
}

/** The effort choices as a listbox; the caller supplies the heading and container. */
export function DraftReasoningEffortList({
  id,
  efforts,
  resolved,
  onPick,
}: {
  id?: string;
  efforts: readonly string[];
  resolved: string;
  onPick: (effort: string) => void;
}) {
  return (
    <div
      id={id}
      role="listbox"
      aria-label="Select reasoning effort"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1"
    >
      {efforts.map(effort => {
        const active = effort === resolved;
        return (
          <button
            key={effort}
            type="button"
            role="option"
            aria-selected={active}
            className={cn(
              'flex w-full items-center rounded-md px-2 py-2 text-left text-sm',
              active ? 'bg-dropdown-selected-item-bg text-dropdown-selected-item-text' : 'hover:bg-ghost-button-hover',
            )}
            onClick={() => onPick(effort)}
          >
            <span className="truncate font-normal">{effort}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Standalone effort control, used where no model menu exists (the agent builder). */
export function DraftReasoningEffortSelector({ disabled, isRunning }: DraftReasoningEffortSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const isMobile = useIsMobile();
  const compactLayout = useCompactLayout();
  const { efforts, resolved, pick } = useReasoningEffortState();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!hasReasoningEfforts(efforts) || !resolved) return null;

  const content = (
    <>
      <div className="border-b border-border px-3 py-2">
        <p className="text-text-primary text-sm font-normal">Reasoning effort</p>
      </div>
      <DraftReasoningEffortList
        id={menuId}
        efforts={efforts}
        resolved={resolved}
        onPick={effort => {
          pick(effort);
          setOpen(false);
        }}
      />
    </>
  );

  return (
    <div ref={containerRef} className="aui-composer-reasoning-selector relative min-w-0">
      <button
        type="button"
        disabled={disabled || isRunning}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Select reasoning effort"
        aria-label={`Reasoning effort: ${resolved}`}
        className={auiButtonClass({
          variant: 'ghost',
          size: 'small',
          className: cn(
            'aui-composer-reasoning-button h-8 max-w-[10rem] min-w-0 gap-1.5 rounded-full px-2 text-xs font-medium',
            'hover:bg-ghost-button-hover',
          ),
        })}
        onClick={() => setOpen(v => !v)}
      >
        <span className="truncate">{resolved}</span>
        <Icon name="chevron-down" className="size-3.5 shrink-0 opacity-60" />
      </button>

      {open ? (
        isMobile || compactLayout ? (
          <BottomSheet open onOpenChange={setOpen} aria-label="Select reasoning effort">
            {content}
          </BottomSheet>
        ) : (
          <div className="aui-popup-enter bg-card-bg text-text-primary absolute right-0 bottom-full z-50 mb-2 flex max-h-[22rem] w-[12rem] flex-col overflow-hidden rounded-lg border border-border shadow-lg">
            {content}
          </div>
        )
      ) : null}
    </div>
  );
}
