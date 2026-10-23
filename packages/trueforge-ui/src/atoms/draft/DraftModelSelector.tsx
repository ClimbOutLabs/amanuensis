'use client';

import { useTrueFoundryAgentSpec, useTrueFoundryUpdateAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useId, useRef, useState } from 'react';

import { Icon } from '../../icons/Icon.js';
import { useOptionalCatalogServer } from '../../server/ServerContext.js';
import { useOptionalShellMode } from '../../server/ShellModeContext.js';
import { auiButtonClass } from '../lib/buttonClasses.js';
import { cn } from '../lib/cn.js';
import { useCompactLayout } from '../lib/CompactLayoutContext.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { BottomSheet } from '../primitives/BottomSheet.js';
import { useDraftCatalog } from './DraftCatalogProvider.js';
import { displayModelLabel, DraftModelCatalogPanel } from './DraftModelCatalogPanel.js';
import { DraftModelMenuPortal, useFloatingMenuPosition } from './DraftModelMenuPortal.js';
import { DraftReasoningEffortList, useReasoningEffortState } from './DraftReasoningEffortSelector.js';
import { hasReasoningEfforts, modelPatchWithReasoningEffort } from './reasoningEffort.js';

export type DraftModelSelectorProps = {
  disabled?: boolean;
  isRunning?: boolean;
};

// Matches the panel's previous fixed width so the composer's compact trigger
// still opens a comfortably wide menu.
const MENU_WIDTH = 288; // 18rem

export function DraftModelSelector({ disabled, isRunning }: DraftModelSelectorProps) {
  const { models, loading, ensureLoaded } = useDraftCatalog();
  const { agentSpec } = useTrueFoundryAgentSpec();
  const updateAgentSpec = useTrueFoundryUpdateAgentSpec();
  const catalog = useOptionalCatalogServer();
  const shell = useOptionalShellMode();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const isMobile = useIsMobile();
  const compactLayout = useCompactLayout();
  const useSheet = isMobile || compactLayout;
  const showConfigureSettingsCta = !loading && models.length === 0 && catalog != null;
  const seededDefaultModelRef = useRef<string | null>(null);
  const effortState = useReasoningEffortState();

  // Desktop only: float the menu in a portal so it escapes whatever container the
  // trigger sits in (a settings card clips an absolutely-positioned menu; a portal
  // does not), right-aligned to match the trigger's usual bottom-right placement.
  const menuPos = useFloatingMenuPosition({
    open: open && !useSheet,
    anchorRef: buttonRef,
    align: 'end',
    width: MENU_WIDTH,
    minWidth: MENU_WIDTH,
  });

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

  // Keep agentSpec in sync with the visual default when no model is set. This
  // only seeds an empty selection; a named model missing from a refreshed
  // catalog is left alone here and instead replaced with the first available
  // model by DraftSpecPreferenceBridge's reconciliation.
  useEffect(() => {
    if (!updateAgentSpec || loading || models.length === 0) return;
    const first = models[0];
    if (first === undefined) return;
    const firstValue = first.name;
    const currentName = agentSpec?.model?.name?.trim() ?? '';
    if (currentName) {
      seededDefaultModelRef.current = null;
      return;
    }
    if (seededDefaultModelRef.current === firstValue) return;
    seededDefaultModelRef.current = firstValue;
    updateAgentSpec({
      model: modelPatchWithReasoningEffort(firstValue, agentSpec?.model?.params, first.properties.reasoningEfforts),
    });
  }, [updateAgentSpec, loading, models, agentSpec?.model?.name, agentSpec?.model?.params]);

  const selectedName = agentSpec?.model?.name ?? models[0]?.name ?? '';
  const selected = models.find(m => m.name === selectedName);
  const label = selected
    ? displayModelLabel(selected.name)
    : selectedName
      ? displayModelLabel(selectedName)
      : loading
        ? 'Loading…'
        : 'Select model';

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const content = (
    <>
      <DraftModelCatalogPanel
        models={models}
        loading={loading}
        selectedName={selectedName}
        query={query}
        onQueryChange={setQuery}
        listboxId={menuId}
        onOpenSettings={
          showConfigureSettingsCta
            ? () => {
                setOpen(false);
                setQuery('');
                shell?.setSettingsOpen(true, 'models');
              }
            : undefined
        }
        onSelect={model => {
          updateAgentSpec?.({
            model: modelPatchWithReasoningEffort(
              model.name,
              agentSpec?.model?.params,
              model.properties.reasoningEfforts,
            ),
          });
          setOpen(false);
          setQuery('');
        }}
      />
      {hasReasoningEfforts(effortState.efforts) && effortState.resolved ? (
        <div className="border-border shrink-0 border-t">
          <p className="text-text-secondary px-3 pt-2 pb-1 text-[0.6875rem] font-medium tracking-wide uppercase">
            Reasoning effort
          </p>
          <DraftReasoningEffortList
            efforts={effortState.efforts}
            resolved={effortState.resolved}
            onPick={effort => {
              effortState.pick(effort);
              setOpen(false);
              setQuery('');
            }}
          />
        </div>
      ) : null}
    </>
  );

  return (
    <div ref={containerRef} className="aui-composer-model-selector relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled || isRunning}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Select model"
        className={auiButtonClass({
          variant: 'ghost',
          size: 'small',
          className: cn(
            'aui-composer-model-button text-text-secondary hover:text-text-primary h-8 max-w-[10rem] min-w-0 shrink gap-1 rounded-full px-2 text-xs font-normal',
            'hover:bg-ghost-button-hover',
          ),
        })}
        onClick={() => setOpen(v => !v)}
      >
        <span className="truncate">{label}</span>
        <Icon name="chevron-down" className="size-3 shrink-0 opacity-60" />
      </button>

      {useSheet && open ? (
        <BottomSheet open onOpenChange={setOpen} aria-label="Select model">
          {content}
        </BottomSheet>
      ) : null}

      {!useSheet && open && menuPos ? (
        <DraftModelMenuPortal anchorRef={buttonRef} menuPos={menuPos} menuRef={menuRef}>
          {content}
        </DraftModelMenuPortal>
      ) : null}
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    DraftModelSelector: typeof DraftModelSelector;
  }
}
