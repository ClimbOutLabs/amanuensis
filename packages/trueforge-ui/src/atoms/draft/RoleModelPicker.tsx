'use client';

import { useTrueFoundryAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useId, useRef, useState } from 'react';

import { Icon } from '../../icons/Icon.js';
import { auiButtonClass } from '../lib/buttonClasses.js';
import { cn } from '../lib/cn.js';
import { useCompactLayout } from '../lib/CompactLayoutContext.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { BottomSheet } from '../primitives/BottomSheet.js';
import { useDraftCatalog } from './DraftCatalogProvider.js';
import { displayModelLabel, DraftModelCatalogPanel, ProviderMark } from './DraftModelCatalogPanel.js';
import { DraftModelMenuPortal, useFloatingMenuPosition } from './DraftModelMenuPortal.js';

export type RoleModelPickerProps = {
  /** Human label used in the "Select … model" title, e.g. "Compaction". */
  roleLabel: string;
  /** The model chosen for the role; undefined while the role follows the main model. */
  roleModelName: string | undefined;
  /** Called with a model name, or undefined to go back to following the main model. */
  onChoose: (modelName: string | undefined) => void;
  disabled?: boolean;
};

/** Picks the model for one job: the main model by default, or one from the catalog. Where the choice is kept is the caller's. */
export function RoleModelPicker({ roleLabel, roleModelName, onChoose, disabled }: RoleModelPickerProps) {
  const { models, loading, ensureLoaded } = useDraftCatalog();
  const { agentSpec } = useTrueFoundryAgentSpec();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const isMobile = useIsMobile();
  const compactLayout = useCompactLayout();
  const useSheet = isMobile || compactLayout;

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

  // Desktop only: float the menu in a portal so it escapes the settings pane's
  // own scroll container, and flip above the trigger when there is no room below.
  const menuPos = useFloatingMenuPosition({ open: open && !useSheet, anchorRef: buttonRef });

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

  const mainModelName = agentSpec?.model?.name ?? '';
  const mainModelCatalogEntry = models.find(m => m.name === mainModelName);
  const mainModelLabel = mainModelName ? displayModelLabel(mainModelName) : loading ? 'Loading…' : 'No model selected';

  const roleCatalogEntry = roleModelName === undefined ? undefined : models.find(m => m.name === roleModelName);
  const isInherited = roleModelName === undefined;
  const isUnavailable = roleModelName !== undefined && roleCatalogEntry === undefined;

  const choose = (modelName: string | undefined) => {
    if (modelName !== roleModelName) onChoose(modelName);
    setOpen(false);
    setQuery('');
  };

  const modelDisplayName = isInherited
    ? mainModelLabel
    : roleCatalogEntry
      ? displayModelLabel(roleCatalogEntry.name)
      : roleModelName !== undefined
        ? displayModelLabel(roleModelName)
        : mainModelLabel;

  const providerCaption = isInherited ? 'Default' : (roleCatalogEntry?.provider.name ?? '');
  const fullLabelTitle = providerCaption ? `${providerCaption} / ${modelDisplayName}` : modelDisplayName;

  const account = roleCatalogEntry?.provider.name ?? (isInherited ? mainModelCatalogEntry?.provider.name : undefined);
  const title = `Select ${roleLabel} model`;

  const content = (
    <>
      <button
        type="button"
        role="option"
        aria-selected={isInherited}
        aria-label={`Default ${mainModelLabel}`}
        className={cn(
          'flex w-full items-start gap-2 border-b border-border px-3 py-2.5 text-left text-sm',
          isInherited ? 'bg-dropdown-selected-item-bg text-dropdown-selected-item-text' : 'hover:bg-ghost-button-hover',
        )}
        onClick={() => choose(undefined)}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">Default</span>
          <span className="truncate text-xs text-text-secondary">Follows the main model, {mainModelLabel}</span>
        </span>
        {isInherited ? <Icon name="check" className="mt-0.5 size-3.5 shrink-0" /> : null}
      </button>
      <DraftModelCatalogPanel
        models={models}
        loading={loading}
        selectedName={roleCatalogEntry ? roleCatalogEntry.name : ''}
        highlightFirstWhenUnselected={false}
        query={query}
        onQueryChange={setQuery}
        listboxId={menuId}
        showHeading={false}
        onSelect={model => choose(model.name)}
      />
    </>
  );

  return (
    <div ref={containerRef} className="relative inline-block w-full">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={title}
        className={auiButtonClass({
          variant: 'secondary',
          size: 'small',
          className: cn(
            'h-auto min-h-9 w-full justify-between gap-2 py-1.5 text-sm',
            isUnavailable && 'border-failure-bg/40 text-failure-bg',
          ),
        })}
        onClick={() => setOpen(v => !v)}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {isUnavailable ? (
            <Icon name="triangle-exclamation" className="size-3.5 shrink-0" />
          ) : (
            <ProviderMark
              logo={roleCatalogEntry?.provider.logo}
              label={account ?? modelDisplayName}
              className="size-4 shrink-0 text-xs"
            />
          )}
          <span className="flex min-w-0 flex-1 flex-col text-left" title={fullLabelTitle}>
            {providerCaption ? (
              <span className="truncate text-[11px] uppercase tracking-wide text-text-secondary">
                {providerCaption}
              </span>
            ) : null}
            <span className="truncate">{modelDisplayName}</span>
          </span>
        </span>
        <Icon name="chevron-down" className="size-3.5 shrink-0 opacity-60" />
      </button>

      {isUnavailable ? <p className="mt-1 text-xs text-failure-bg">Not in the current model catalog</p> : null}

      {useSheet && open ? (
        <BottomSheet open onOpenChange={setOpen} aria-label={title}>
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
