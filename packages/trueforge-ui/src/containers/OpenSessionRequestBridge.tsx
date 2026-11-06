'use client';

import { useEffect, useRef, type FC } from 'react';

import { useOpenChatById } from '../hooks/useOpenChatById.js';
import type { OpenSessionRequest } from '../server/ShellModeContext.js';

/**
 * Answers host requests to open a chat by id (the right rail's desk rows), through the same
 * open-by-id path the history list uses. Mounted inside the shell tree, where that path
 * lives; the rail itself renders outside it. The first nonce seen is the mount value and is
 * remembered, not answered: only a later change is a fresh ask.
 */
export const OpenSessionRequestBridge: FC<{ request?: OpenSessionRequest | undefined }> = ({ request }) => {
  const openChatById = useOpenChatById();
  const lastNonce = useRef(request?.nonce);
  useEffect(() => {
    if (request === undefined) {
      return;
    }
    if (lastNonce.current === request.nonce) {
      return;
    }
    lastNonce.current = request.nonce;
    openChatById(request.sessionId);
  }, [request, openChatById]);
  return null;
};
