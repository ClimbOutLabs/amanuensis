'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useAuiState } from '@assistant-ui/react';
import { useEffect, useRef } from 'react';

import { useOptionalSentinelState, type SentinelState } from '../sentinel/SentinelStateProvider.js';
import { isSpeechOutputSupported, speakText, stopSpeaking } from '../utils/speechOutput.js';
import { readSpeechVoiceURI, useSpeakVoiceReplies } from '../utils/speechReplyPreferences.js';
import {
  approvalSpeechLine,
  finalAnswerSpeech,
  limitSpeechWords,
  pendingApprovalCallIds,
  type SpeechContentPart,
} from '../utils/speechText.js';
import { disarmSpokenReply, noteUserMessage, takeSpokenReply } from '../utils/voiceTurn.js';

type SpeakableMessage = {
  readonly id: string;
  readonly role: string;
  readonly status?: { readonly type: string };
  readonly content: readonly SpeechContentPart[];
};

function lastMessageWithRole(messages: readonly SpeakableMessage[], role: string): SpeakableMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === role) return message;
  }
  return undefined;
}

function textOf(message: SpeakableMessage): string {
  return message.content.map(part => part.text ?? '').join('');
}

/** One short line for a reply that waits on an approval; the approval itself stays on screen. */
function approvalLine(content: readonly SpeechContentPart[], sentinel: SentinelState | null): string | undefined {
  const callIds = pendingApprovalCallIds(content);
  if (callIds.length === 0) return undefined;
  for (const callId of callIds) {
    const info = sentinel?.approvalFor(callId);
    if (info !== undefined) return approvalSpeechLine(info.card.plain_what);
  }
  return approvalSpeechLine('');
}

/**
 * Reads the reply to a voice-sent message aloud once its turn finishes: the final answer, or one
 * short line when the turn waits for an approval. Speech never answers an approval.
 */
export function SpokenReplyContainer() {
  const isRunning = useThreadIsRunning();
  const sentinel = useOptionalSentinelState();
  const messages = useAuiState(s => s.thread.messages);
  const threadId = useAuiState(s => s.threadListItem.id);
  const { enabled } = useSpeakVoiceReplies();
  const latestUser = lastMessageWithRole(messages, 'user');
  const latestUserId = latestUser?.id;
  const latestUserText = latestUser === undefined ? '' : textOf(latestUser);
  const wasRunning = useRef(isRunning);
  const runThreadId = useRef(threadId);
  const seenUserId = useRef(latestUserId);
  // Set when a voice-armed turn finishes in the chat it started in; the reply is read once its
  // message is final, because the runtime still holds the optimistic running message in the render
  // where the turn ends.
  const replyDue = useRef(false);

  // Switching chats, or leaving this one, ends a reply in progress and any voice send still waiting.
  useEffect(() => {
    disarmSpokenReply();
    replyDue.current = false;
    stopSpeaking();
  }, [threadId]);

  useEffect(() => () => stopSpeaking(), []);

  // A new user message is either the voice send's own message or the end of that send.
  useEffect(() => {
    if (latestUserId === undefined || latestUserId === seenUserId.current) return;
    seenUserId.current = latestUserId;
    noteUserMessage({ id: latestUserId, text: latestUserText });
  }, [latestUserId, latestUserText]);

  useEffect(() => {
    const finished = wasRunning.current && !isRunning;
    wasRunning.current = isRunning;
    if (isRunning) {
      replyDue.current = false;
      runThreadId.current = threadId;
      return;
    }
    if (finished) replyDue.current = takeSpokenReply(latestUserId);
  }, [isRunning, threadId, latestUserId]);

  useEffect(() => {
    if (!replyDue.current || isRunning) return;
    const message = lastMessageWithRole(messages, 'assistant');
    if (message === undefined || message.status?.type === 'running') return;
    replyDue.current = false;
    // Switching chats ends a run as seen here too; only the chat the voice turn started in is read.
    if (runThreadId.current !== threadId) return;
    if (!enabled || !isSpeechOutputSupported()) return;
    const sentinelLine = approvalLine(message.content, sentinel);
    const text = sentinelLine ?? limitSpeechWords(finalAnswerSpeech(message.content));
    speakText({ key: message.id, text, voiceURI: readSpeechVoiceURI() });
  }, [isRunning, messages, enabled, sentinel, threadId]);

  return null;
}
