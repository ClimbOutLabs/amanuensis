'use client';

import {
  useTrueFoundryAgentSpec,
  useTrueFoundryUpdateAgentSpec,
  type AgentSpecUpdate,
} from '@truefoundry/assistant-ui-runtime';
import { useEffect, useId, useRef, useState } from 'react';

import { Icon } from '../../icons/Icon.js';
import type { Model, ModelSelection } from '../../server/types.js';
import { auiButtonClass } from '../lib/buttonClasses.js';
import { cn } from '../lib/cn.js';
import { useCompactLayout } from '../lib/CompactLayoutContext.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { BottomSheet } from '../primitives/BottomSheet.js';
import { useDraftCatalog } from './DraftCatalogProvider.js';
import { displayModelLabel, DraftModelCatalogPanel, ProviderMark } from './DraftModelCatalogPanel.js';
import { DraftModelMenuPortal, useFloatingMenuPosition } from './DraftModelMenuPortal.js';

/**
 * Model roles for the host's own bounded operations. A role exists only where
 * a distinct model call does; see `auxiliary_models` on the agent spec.
 */
export type AuxiliaryModelRole = 'compaction' | 'delegation' | 'summarization';

export type AuxiliaryModels = {
  compaction?: Model;
  delegation?: Model;
  summarization?: Model;
};

export type DraftAuxiliaryModelSelectorProps = {
  role: AuxiliaryModelRole;
  /** Human label used in titles and the "Select … model" affordance, e.g. "Compaction". */
  roleLabel: string;
  disabled?: boolean;
};

/**
 * Reads a role's model from the spec. The spec type comes from the external runtime package
 * and may lag behind newly added roles; treating it as the UI's AuxiliaryModels (a supertype
 * with the new role as optional) is safe for reads — an unset role simply yields undefined.
 */
function getRoleModel(auxiliaryModels: AuxiliaryModels | undefined, role: AuxiliaryModelRole): Model | undefined {
  return auxiliaryModels?.[role];
}

export function DraftAuxiliaryModelSelector({ role, roleLabel, disabled }: DraftAuxiliaryModelSelectorProps) {
  const { models, loading, ensureLoaded } = useDraftCatalog();
  const { agentSpec } = useTrueFoundryAgentSpec();
  const updateAgentSpec = useTrueFoundryUpdateAgentSpec();
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

  const spec = agentSpec;
  const mainModelName = spec?.model?.name ?? '';
  const mainModelCatalogEntry = models.find(m => m.name === mainModelName);
  const mainModelLabel = mainModelName ? displayModelLabel(mainModelName) : loading ? 'Loading…' : 'No model selected';

  const roleModel = getRoleModel(spec?.auxiliaryModels, role);
  const roleCatalogEntry = roleModel ? models.find(m => m.name === roleModel.name) : undefined;
  const isInherited = roleModel === undefined;
  const isUnavailable = roleModel !== undefined && roleCatalogEntry === undefined;

  const applyAuxiliaryModels = (next: AuxiliaryModels | undefined) => {
    const patch: AgentSpecUpdate = { auxiliaryModels: next };
    updateAgentSpec?.(patch);
  };

  const selectDefault = () => {
    const current = spec?.auxiliaryModels;
    if (getRoleModel(current, role) !== undefined) {
      const next: AuxiliaryModels = { ...current };
      delete next[role];
      applyAuxiliaryModels(Object.keys(next).length > 0 ? next : undefined);
    }
    setOpen(false);
    setQuery('');
  };

  const selectModel = (model: ModelSelection) => {
    const current = spec?.auxiliaryModels;
    applyAuxiliaryModels({ ...current, [role]: { name: model.name } });
    setOpen(false);
    setQuery('');
  };

  const modelDisplayName = isInherited
    ? mainModelLabel
    : roleCatalogEntry
      ? displayModelLabel(roleCatalogEntry.name)
      : roleModel
        ? displayModelLabel(roleModel.name)
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
        onClick={selectDefault}
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
        onSelect={selectModel}
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
