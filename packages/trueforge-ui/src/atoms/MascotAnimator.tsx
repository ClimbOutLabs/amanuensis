'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useAuiState } from '@assistant-ui/react';
import * as React from 'react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useOptionalComposerBusyState } from '../hooks/useComposerBusyState.js';
import { useOptionalComposerPauseView } from '../hooks/useComposerPauseView.js';
import { cn } from './lib/cn.js';

export type MascotAction =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'working'
  | 'waiting'
  | 'celebrating'
  | 'oops'
  | 'sleeping';

type MascotAnimatorState = {
  composerHasText: boolean;
  isThreadRunning: boolean;
  composerBusy: boolean;
  pauseView: 'mcp' | 'ask-user' | 'approval' | 'custom' | 'compose';
  lastMessageRole?: string;
  lastToolName?: string;
  messageStatus?: string;
  messageParts: ReadonlyArray<{ type: string; status?: { type: string }; toolName?: string }>;
};

/**
 * Pure mapping from chat state to animation action.
 * This function is deterministic and side-effect free for testing.
 */
export function mascotActionFor(state: MascotAnimatorState): MascotAction {
  const { pauseView, isThreadRunning, lastToolName, messageParts } = state;

  // Check pause states first (highest priority)
  if (pauseView === 'mcp' || pauseView === 'ask-user' || pauseView === 'approval' || pauseView === 'custom') {
    return 'waiting';
  }

  // Get the last tool call if any
  const lastToolCall = [...messageParts].reverse().find(part => part.type === 'tool-call');
  const activeToolName = lastToolCall?.toolName || lastToolName;

  // If something is running
  if (isThreadRunning) {
    // Classify by tool type
    if (activeToolName) {
      if (
        activeToolName === 'read_file' ||
        activeToolName === 'web_fetch' ||
        activeToolName === 'extract_document_text' ||
        activeToolName === 'document.ingestion'
      ) {
        return 'reading';
      }
      if (activeToolName === 'web_search') {
        return 'searching';
      }
      if (
        activeToolName.includes('exec') ||
        activeToolName.includes('edit') ||
        activeToolName.includes('file') ||
        activeToolName === 'bash' ||
        activeToolName === 'sh'
      ) {
        return 'working';
      }
    }
    // Default while running: thinking
    return 'thinking';
  }

  // Not running, composer state
  if (state.composerHasText && !state.composerBusy) {
    return 'listening';
  }

  return 'idle';
}

/**
 * Tracks animation state to ensure long-running animations rotate variants
 * and never repeat the same variant twice in a row.
 */
class VariantRotator {
  private state: Map<MascotAction, number> = new Map();

  getVariant(action: MascotAction, maxVariants: number): number {
    if (maxVariants <= 1) return 0;

    const current = this.state.get(action) ?? 0;
    const next = (current + 1) % maxVariants;
    this.state.set(action, next);
    return current;
  }

  reset(): void {
    this.state.clear();
  }
}

export type MascotAnimatorProps = {
  src?: string;
  alt?: string;
  children?: ReactNode;
  className?: string;
};

/**
 * Error boundary component for MascotAnimator that catches context errors.
 * This wraps MascotAnimatorContent which uses hooks that might fail if contexts are missing.
 */
class MascotAnimatorErrorBoundary extends React.Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    // Log errors from missing providers for debugging
    console.error('MascotAnimatorErrorBoundary caught an error:', error);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

function MascotAnimatorContent({ src, alt, className, children }: MascotAnimatorProps) {
  const isThreadRunning = useThreadIsRunning();
  const composerBusyState = useOptionalComposerBusyState();
  const composerBusy = composerBusyState?.isBusy ?? false;
  const pauseView = useOptionalComposerPauseView();

  const composerText = useAuiState(s => s.composer?.text || '');
  const composerHasText = (composerText?.trim() ?? '').length > 0;

  const lastMessageRole = useAuiState(s => {
    const messages = s.thread?.messages || [];
    return messages[messages.length - 1]?.role;
  });

  const messageParts = useAuiState(s => {
    if (lastMessageRole !== 'assistant') return [];
    return (
      s.thread?.messages
        ?.find(m => m.role === 'assistant')
        ?.parts?.map(p => ({
          type: p.type,
          status: p.status,
          toolName: p.type === 'tool-call' ? p.toolName : undefined,
        })) || []
    );
  });

  const lastMessageStatus = useAuiState(s => {
    const messages = s.thread?.messages || [];
    const last = messages[messages.length - 1];
    return last?.role === 'assistant' ? last.status : undefined;
  });

  const currentAction = useMemo<MascotAction>(() => {
    return mascotActionFor({
      composerHasText,
      isThreadRunning,
      composerBusy,
      pauseView: pauseView.kind,
      lastMessageRole,
      messageParts,
    });
  }, [composerHasText, isThreadRunning, composerBusy, pauseView, lastMessageRole, messageParts]);

  const variantRotator = useRef(new VariantRotator());
  const [variant, setVariant] = useState(0);
  const [showCelebration, setShowCelebration] = useState(false);
  const [showError, setShowError] = useState(false);
  const [isSleeping, setIsSleeping] = useState(false);
  const prevActionRef = useRef<MascotAction>(currentAction);
  const sleepTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const celebrationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastActivityRef = useRef(Date.now());
  const containerRef = useRef<HTMLDivElement>(null);

  // Handle celebration/error states on turn completion
  useEffect(() => {
    if (!isThreadRunning && lastMessageRole === 'assistant') {
      const hasError = lastMessageStatus?.type === 'incomplete' && lastMessageStatus.reason === 'error';
      if (hasError) {
        setShowError(true);
        const timeout = setTimeout(() => setShowError(false), 2500);
        celebrationTimeoutRef.current = timeout;
      } else {
        setShowCelebration(true);
        const timeout = setTimeout(() => setShowCelebration(false), 2000);
        celebrationTimeoutRef.current = timeout;
      }
    }
    // Cleanup previous celebration/error timeout when dependencies change
    return () => {
      if (celebrationTimeoutRef.current) {
        clearTimeout(celebrationTimeoutRef.current);
        celebrationTimeoutRef.current = null;
      }
    };
  }, [isThreadRunning, lastMessageRole, lastMessageStatus]);

  // Track action changes and rotate variants
  useEffect(() => {
    if (currentAction !== prevActionRef.current) {
      const variantsForAction =
        currentAction === 'thinking' || currentAction === 'working' || currentAction === 'searching' ? 2 : 1;
      const newVariant = variantRotator.current.getVariant(currentAction, variantsForAction);
      setVariant(newVariant);
      prevActionRef.current = currentAction;
    }
  }, [currentAction]);

  // Track activity for sleep state
  useEffect(() => {
    lastActivityRef.current = Date.now();
    if (sleepTimeoutRef.current) {
      clearTimeout(sleepTimeoutRef.current);
    }

    if (currentAction === 'idle' && !composerHasText) {
      sleepTimeoutRef.current = setTimeout(() => {
        setIsSleeping(true);
      }, 90000); // 90 seconds
    } else {
      setIsSleeping(false);
    }

    return () => {
      if (sleepTimeoutRef.current) {
        clearTimeout(sleepTimeoutRef.current);
      }
    };
  }, [currentAction, composerHasText]);

  // Pause animations when tab is hidden
  useEffect(() => {
    const handleVisibilityChange = () => {
      const element = containerRef.current;
      if (element) {
        element.classList.toggle('mascot-animator--paused', document.hidden);
      }
    };

    // Apply initial state on mount
    handleVisibilityChange();

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      setPrefersReducedMotion(mediaQuery.matches);

      const handleChange = (e: MediaQueryListEvent) => {
        setPrefersReducedMotion(e.matches);
      };

      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
  }, []);

  const animationClass = isSleeping
    ? 'mascot-animator--sleeping'
    : showCelebration
      ? 'mascot-animator--celebrating'
      : showError
        ? 'mascot-animator--oops'
        : `mascot-animator--${currentAction}`;

  const variantClass = variant > 0 ? `mascot-animator--variant-${variant}` : '';

  const containerStyle: CSSProperties & { '--mascot-action': string } = {
    '--mascot-action': currentAction,
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        'mascot-animator__container',
        animationClass,
        variantClass,
        prefersReducedMotion && 'mascot-animator--reduced-motion',
        className,
      )}
      role="img"
      aria-label={src ? undefined : alt}
      aria-hidden={!src}
      style={containerStyle}
    >
      {src && <img className="mascot-animator__image" src={src} alt={alt} />}
      <div className="mascot-animator__halo" aria-hidden="true" />
      <div className="mascot-animator__glyphs" aria-hidden="true" />
      {children}
    </div>
  );
}

/** Fallback component when animation context is not available. */
function MascotAnimatorFallback({ src, alt, className, children }: MascotAnimatorProps) {
  return (
    <div
      className={cn('mascot-animator__container', 'mascot-animator--idle', className)}
      role="img"
      aria-label={src ? undefined : alt}
      aria-hidden={!src}
    >
      {src && <img className="mascot-animator__image" src={src} alt={alt} />}
      {children}
    </div>
  );
}

export function MascotAnimator(props: MascotAnimatorProps) {
  return (
    <MascotAnimatorErrorBoundary fallback={<MascotAnimatorFallback {...props} />}>
      <MascotAnimatorContent {...props} />
    </MascotAnimatorErrorBoundary>
  );
}
