'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** How long a forget waits before it reaches the server. Undo inside this window cancels it. */
export const FORGET_UNDO_MS = 10_000;

/**
 * Holds forgotten memories for FORGET_UNDO_MS before the server call. They stay hidden while
 * held. Starting a new forget sends the held batch at once, so only one undo is ever offered.
 * Unmounting sends the held batch too: leaving the page must not quietly undo a forget.
 */
export function useForgetWithUndo(options: { commit: (ids: string[]) => Promise<void> }) {
  const { commit } = options;
  const [held, setHeld] = useState<string[] | null>(null);
  const heldRef = useRef<{ ids: string[]; timer: ReturnType<typeof setTimeout> } | null>(null);
  const commitRef = useRef(commit);

  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);

  const sendHeld = useCallback(() => {
    const current = heldRef.current;
    if (current === null) return;
    clearTimeout(current.timer);
    heldRef.current = null;
    setHeld(null);
    void commitRef.current(current.ids);
  }, []);

  const forget = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      sendHeld();
      const timer = setTimeout(sendHeld, FORGET_UNDO_MS);
      heldRef.current = { ids, timer };
      setHeld(ids);
    },
    [sendHeld],
  );

  const undo = useCallback(() => {
    const current = heldRef.current;
    if (current === null) return;
    clearTimeout(current.timer);
    heldRef.current = null;
    setHeld(null);
  }, []);

  useEffect(() => () => sendHeld(), [sendHeld]);

  const heldIds = useMemo(() => new Set(held ?? []), [held]);

  return { heldIds, heldCount: heldIds.size, forget, undo };
}
