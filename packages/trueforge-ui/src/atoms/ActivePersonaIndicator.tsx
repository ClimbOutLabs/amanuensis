'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useAuiState } from '../assistant-ui.js';
import {
  useOptionalPersonas,
  type Persona,
  type PersonaApi,
  type SessionPersona,
} from '../components/PersonaContext.js';
import { Icon } from '../icons/Icon.js';
import { registerPersonaMutation } from '../personaMutationGate.js';
import { displayModelLabel } from './draft/DraftModelCatalogPanel.js';
import { auiButtonClass } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';

export type ActivePersonaIndicatorProps = {
  disabled?: boolean;
};

/**
 * Says who is answering this chat, and offers the configured personas as a
 * compact picker next to the chip.
 *
 * The server decides the persona when a turn is created, so the chip re-reads
 * once a turn finishes rather than guessing from the message the user typed.
 * With no persona active and nothing to pick from it renders nothing, which is
 * what every chat looks like until someone names one.
 *
 * The thread hooks live in the inner component on purpose: a host that never
 * wired a persona API must not be dragged into requiring an `AuiProvider` by a
 * control that would render nothing anyway.
 */
export function ActivePersonaIndicator({ disabled }: ActivePersonaIndicatorProps) {
  const personas = useOptionalPersonas();
  if (personas == null) {
    return null;
  }
  return (
    <ActivePersonaChip
      getSessionPersona={personas.getSessionPersona}
      setSessionPersona={personas.setSessionPersona}
      personas={personas.personas}
      {...(disabled === undefined ? {} : { disabled })}
    />
  );
}

function ActivePersonaChip({
  getSessionPersona,
  setSessionPersona,
  personas,
  disabled,
}: Pick<PersonaApi, 'getSessionPersona' | 'setSessionPersona'> & {
  personas: Persona[];
} & ActivePersonaIndicatorProps) {
  const sessionId = useAuiState(state => state.threadListItem.remoteId);
  const isRunning = useThreadIsRunning();
  const menuId = useId();
  const [active, setActive] = useState<SessionPersona | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [lookupRetry, setLookupRetry] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const sessionIdRef = useRef(sessionId);
  const lookupGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const menuContainerRef = useRef<HTMLSpanElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    lookupGenerationRef.current += 1;
    mutationGenerationRef.current += 1;
    setActive(null);
    setBusy(false);
    setStatusUnavailable(false);
    setMenuOpen(false);
  }, [sessionId]);

  useEffect(() => {
    // A run in flight is about to change the answer; read once it settles.
    // A speaker mutation is already authoritative for its own result, so do not
    // race it with a lookup that may observe the state before the write lands.
    if (sessionId == null || isRunning || busy) {
      lookupGenerationRef.current += 1;
      if (sessionId == null) {
        setActive(null);
      }
      return;
    }
    const lookupGeneration = ++lookupGenerationRef.current;
    let cancelled = false;
    void getSessionPersona(sessionId)
      .then(next => {
        if (!cancelled && lookupGenerationRef.current === lookupGeneration) {
          setActive(next);
          setStatusUnavailable(false);
        }
      })
      .catch(() => {
        if (!cancelled && lookupGenerationRef.current === lookupGeneration) {
          setActive(null);
          setStatusUnavailable(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [busy, getSessionPersona, sessionId, isRunning, lookupRetry]);

  // Dismiss the picker on outside click or Escape; Escape hands focus back to
  // the trigger so keyboard users are not stranded on a removed menu.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (menuContainerRef.current != null && target instanceof Node && !menuContainerRef.current.contains(target)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuTriggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const retryStatus = useCallback(() => {
    if (sessionId == null || isRunning || busy) {
      return;
    }
    setStatusUnavailable(false);
    setLookupRetry(value => value + 1);
  }, [busy, isRunning, sessionId]);

  const applyPersona = useCallback(
    (personaId: string | null) => {
      if (sessionId == null) {
        return;
      }
      setMenuOpen(false);
      if (active?.persona_id === personaId) {
        return;
      }
      const requestedSessionId = sessionId;
      const mutationGeneration = ++mutationGenerationRef.current;
      lookupGenerationRef.current += 1;
      setBusy(true);
      setStatusUnavailable(false);
      // Register the mutation so a turn created while the PUT is in flight
      // waits for the new activation instead of answering as the old persona.
      const mutation = setSessionPersona(sessionId, personaId)
        .then(next => {
          if (sessionIdRef.current === requestedSessionId && mutationGenerationRef.current === mutationGeneration) {
            setActive(next);
            setStatusUnavailable(false);
          }
        })
        .catch(() => {
          if (sessionIdRef.current === requestedSessionId && mutationGenerationRef.current === mutationGeneration) {
            setActive(null);
            setStatusUnavailable(true);
          }
        })
        .finally(() => {
          if (sessionIdRef.current === requestedSessionId && mutationGenerationRef.current === mutationGeneration) {
            setBusy(false);
          }
        });
      registerPersonaMutation(mutation);
      void mutation;
    },
    [setSessionPersona, sessionId, active],
  );

  if (statusUnavailable) {
    return (
      <span
        className="text-warning-bg flex min-w-0 items-center gap-1 rounded-full border border-warning-bg/40 bg-warning-bg/10 px-2 py-0.5 text-xs font-medium"
        data-testid="active-persona-unavailable"
        title="The active speaker could not be refreshed"
      >
        <Icon name="triangle-exclamation" className="size-3.5 shrink-0" />
        <span className="truncate">Speaker status unavailable</span>
        <button
          type="button"
          aria-label="Retry active speaker status"
          title="Retry active speaker status"
          disabled={disabled || busy || isRunning}
          className={cn(auiButtonClass({ variant: 'ghost', size: 'icon' }), 'size-5 shrink-0')}
          onClick={retryStatus}
        >
          <Icon name="rotate-right" className="size-3" />
        </button>
      </span>
    );
  }

  const pickerAvailable = personas.length > 0;
  const showChip = active?.persona_id != null && active.persona_name != null;
  if (!showChip && !pickerAvailable) {
    // No active speaker and nothing to pick: every chat looks like this until
    // someone configures a persona.
    return null;
  }
  const triggerDisabled = disabled || busy || isRunning || sessionId == null;
  const model = active?.model_name == null ? '' : displayModelLabel(active.model_name);

  return (
    <span
      ref={menuContainerRef}
      className="relative flex min-w-0 items-center gap-1"
      data-testid="active-persona-picker"
    >
      {showChip ? (
        <span
          className="flex min-w-0 items-center gap-1 rounded-full border border-border bg-secondary-bg/50 py-0.5 pl-2 pr-0.5 text-xs"
          data-testid="active-persona"
        >
          <Icon name="robot" className="size-3.5 shrink-0" />
          <span className="truncate font-medium text-text-primary">{active.persona_name}</span>
          {model ? <span className="truncate text-text-secondary">· {model}</span> : null}
          <button
            type="button"
            aria-label={`Return to the default assistant (currently ${active.persona_name})`}
            title="Return to the default assistant"
            disabled={disabled || busy}
            className={cn(auiButtonClass({ variant: 'ghost', size: 'icon' }), 'size-5 shrink-0')}
            onClick={() => applyPersona(null)}
          >
            <Icon name="xmark" className="size-3" />
          </button>
        </span>
      ) : null}
      {pickerAvailable ? (
        <>
          <button
            ref={menuTriggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            aria-label="Choose who answers this chat"
            title="Choose who answers this chat"
            disabled={triggerDisabled}
            className={cn(auiButtonClass({ variant: 'ghost', size: 'icon' }), 'size-5 shrink-0')}
            onClick={() => setMenuOpen(open => !open)}
          >
            <Icon name="chevron-down" className="size-3" />
          </button>
          {menuOpen ? (
            <div
              id={menuId}
              role="menu"
              aria-label="Personas"
              className="absolute bottom-full right-0 z-50 mb-1 w-52 overflow-hidden rounded-md border border-border bg-card-bg py-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                aria-label="Default assistant"
                disabled={triggerDisabled}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text-primary',
                  'hover:bg-ghost-button-hover focus-visible:bg-ghost-button-hover focus-visible:outline-none',
                  'disabled:opacity-50',
                )}
                onClick={() => applyPersona(null)}
              >
                <span className="min-w-0 flex-1 truncate">Default assistant</span>
                {active?.persona_id == null ? <Icon name="check" className="size-3.5 shrink-0" /> : null}
              </button>
              {personas.map(persona => (
                <button
                  key={persona.id}
                  type="button"
                  role="menuitem"
                  aria-label={persona.display_name}
                  disabled={triggerDisabled}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text-primary',
                    'hover:bg-ghost-button-hover focus-visible:bg-ghost-button-hover focus-visible:outline-none',
                    'disabled:opacity-50',
                  )}
                  onClick={() => applyPersona(persona.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{persona.display_name}</span>
                    {persona.model_name ? (
                      <span className="block truncate text-xs text-text-secondary">
                        {displayModelLabel(persona.model_name)}
                      </span>
                    ) : null}
                  </span>
                  {active?.persona_id === persona.id ? <Icon name="check" className="size-3.5 shrink-0" /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </span>
  );
}
