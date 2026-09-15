'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuiState } from '../assistant-ui.js';
import { useOptionalPersonas, type PersonaApi, type SessionPersona } from '../components/PersonaContext.js';
import { Icon } from '../icons/Icon.js';
import { displayModelLabel } from './draft/DraftModelCatalogPanel.js';
import { auiButtonClass } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';

export type ActivePersonaIndicatorProps = {
  disabled?: boolean;
};

/**
 * Says who is answering this chat, and gives one click back to the default
 * assistant.
 *
 * The server decides the persona when a turn is created, so this re-reads once
 * a turn finishes rather than guessing from the message the user typed. With
 * no persona active it renders nothing, which is what every chat looks like
 * until someone names one.
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
      {...(disabled === undefined ? {} : { disabled })}
    />
  );
}

function ActivePersonaChip({
  getSessionPersona,
  setSessionPersona,
  disabled,
}: Pick<PersonaApi, 'getSessionPersona' | 'setSessionPersona'> & ActivePersonaIndicatorProps) {
  const sessionId = useAuiState(state => state.threadListItem.remoteId);
  const isRunning = useThreadIsRunning();
  const [active, setActive] = useState<SessionPersona | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [lookupRetry, setLookupRetry] = useState(0);
  const sessionIdRef = useRef(sessionId);
  const lookupGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    lookupGenerationRef.current += 1;
    mutationGenerationRef.current += 1;
    setActive(null);
    setBusy(false);
    setStatusUnavailable(false);
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

  const retryStatus = useCallback(() => {
    if (sessionId == null || isRunning || busy) {
      return;
    }
    setStatusUnavailable(false);
    setLookupRetry(value => value + 1);
  }, [busy, isRunning, sessionId]);

  const returnToDefault = useCallback(() => {
    if (sessionId == null) {
      return;
    }
    const requestedSessionId = sessionId;
    const mutationGeneration = ++mutationGenerationRef.current;
    lookupGenerationRef.current += 1;
    setBusy(true);
    setStatusUnavailable(false);
    void setSessionPersona(sessionId, null)
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
  }, [setSessionPersona, sessionId]);

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

  if (active?.persona_id == null || active.persona_name == null) {
    return null;
  }

  const model = active.model_name == null ? '' : displayModelLabel(active.model_name);

  return (
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
        onClick={returnToDefault}
      >
        <Icon name="xmark" className="size-3" />
      </button>
    </span>
  );
}
