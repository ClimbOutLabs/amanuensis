'use client';

import type { PartState } from '@assistant-ui/core/react';
import { useAuiState } from '@assistant-ui/react';
import { ROOT_THREAD_ID, useTrueFoundryReload } from '@truefoundry/assistant-ui-runtime';
import { useState } from 'react';

import { useActiveSessionCanManage } from '../hooks/useResourcePermissions.js';
import { hasSessionResync, type HeldActionDecision } from '../plugins/trueforge-agent-server-adapter/sessionResync.js';
import { HELD_EXPIRED_TEXT, HeldActionCard, type HeldActionStatus } from '../sentinel/HeldActionCard.js';
import { NeedsYourOk } from '../sentinel/NeedsYourOk.js';
import { useOptionalSentinelState } from '../sentinel/SentinelStateProvider.js';
import type { SentinelApprovalInfo } from '../sentinel/types.js';
import { useOptionalServer } from '../server/ServerContext.js';

const GENERIC_FAILURE = 'That did not go through. Try again in a moment.';

/**
 * HOOK: the one place to say where a held action came from, for example "From the 7am brief, which
 * read your email". Nothing writes it yet; the card shows it above the action when it is set.
 */
function heldProvenanceLine(_info: SentinelApprovalInfo): string | null {
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

/** The server's plain refusal ("Expired, nothing was done...") when it sent one. */
function refusalMessage(error: unknown): string | undefined {
  if (!(error instanceof Error) || Reflect.get(error, 'statusCode') !== 422) return undefined;
  const body: unknown = Reflect.get(error, 'body');
  const detail = isRecord(body) ? body.error : undefined;
  const message = isRecord(detail) ? detail.message : undefined;
  return typeof message === 'string' && message !== '' ? message : undefined;
}

type Working = { kind: 'working' } | { kind: 'failed'; message: string };

/**
 * The "Needs your OK" block at the end of a finished assistant message: one card for each action the
 * run held, built from the server's cards and never from the model's text. Answering asks the server
 * to run exactly the held call, or drop it, and then reloads the chat to show the result.
 */
export function NeedsYourOkContainer({ parts }: { parts: readonly PartState[] }): React.JSX.Element | null {
  const sentinel = useOptionalSentinelState();
  const server = useOptionalServer();
  const reload = useTrueFoundryReload();
  const canManage = useActiveSessionCanManage();
  const sessionId = useAuiState(state => state.threadListItem.remoteId ?? undefined);
  const messageStatus = useAuiState(state => state.message.status?.type);
  const [inFlight, setInFlight] = useState<ReadonlyMap<string, Working>>(new Map());

  if (sentinel == null) return null;
  const held = parts.flatMap(part => {
    const info = part.type === 'tool-call' ? sentinel.heldFor(part.toolCallId) : undefined;
    return info === undefined ? [] : [info];
  });
  // While the run is still going its newest turn cannot be answered, so the block waits for the end.
  if (held.length === 0 || messageStatus === 'running') return null;

  const setStatus = (toolCallId: string, next: Working | undefined) =>
    setInFlight(previous => {
      const copy = new Map(previous);
      if (next === undefined) copy.delete(toolCallId);
      else copy.set(toolCallId, next);
      return copy;
    });

  const answer = async (info: SentinelApprovalInfo, decision: HeldActionDecision) => {
    if (server == null || !hasSessionResync(server) || sessionId == null) return;
    setStatus(info.toolCallId, { kind: 'working' });
    try {
      await server.answerHeldAction({
        sessionId,
        threadId: info.threadId ?? ROOT_THREAD_ID,
        toolCallId: info.toolCallId,
        answer: decision,
      });
      sentinel.recordAnswer(info.toolCallId, decision === 'deny' ? 'denied' : 'approved');
      setStatus(info.toolCallId, undefined);
      reload();
    } catch (error) {
      console.error('Held action could not be answered', error);
      setStatus(info.toolCallId, { kind: 'failed', message: refusalMessage(error) ?? GENERIC_FAILURE });
    }
  };

  const statusOf = (info: SentinelApprovalInfo): HeldActionStatus => {
    const answered = sentinel.answerFor(info.toolCallId);
    if (answered !== undefined) return { kind: answered };
    const local = inFlight.get(info.toolCallId);
    if (local?.kind === 'failed' && local.message === HELD_EXPIRED_TEXT) return { kind: 'expired' };
    if (local !== undefined) return local;
    const expiresAt = info.held?.expiresAt;
    return expiresAt != null && Date.parse(expiresAt) <= Date.now() ? { kind: 'expired' } : { kind: 'waiting' };
  };

  return (
    <NeedsYourOk>
      {held.map(info => (
        <HeldActionCard
          key={info.toolCallId}
          card={info.card}
          status={statusOf(info)}
          alwaysAllowOffered={info.held?.alwaysAllowOffered === true}
          disabled={!canManage || server == null || !hasSessionResync(server)}
          provenance={heldProvenanceLine(info)}
          onApprove={() => void answer(info, 'approve')}
          onAlwaysAllow={() => void answer(info, 'always_allow')}
          onDeny={() => void answer(info, 'deny')}
        />
      ))}
    </NeedsYourOk>
  );
}
