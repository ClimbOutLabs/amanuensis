import { useAuiState } from '@assistant-ui/react';
import { useState } from 'react';

/** The only composer placeholders. The assistant asks these itself, so they never carry its name. */
export const COMPOSER_PLACEHOLDER_LINES: readonly string[] = [
  "What's on your mind?",
  'What can I take off your plate?',
  'What are we working on today?',
  'How can I help?',
  'Where should we start?',
  'What would make today easier?',
  "What's next?",
  'Tell me what you need.',
  'Anything I can help with?',
  'Ask me anything, big or small.',
];

/** Picks one line; `random` returns a number in [0, 1), as `Math.random` does. */
export function pickComposerPlaceholder(random: () => number): string {
  const index = Math.min(
    Math.floor(random() * COMPOSER_PLACEHOLDER_LINES.length),
    COMPOSER_PLACEHOLDER_LINES.length - 1,
  );
  const line = COMPOSER_PLACEHOLDER_LINES[index];
  if (line === undefined) throw new Error('Composer placeholder list is empty');
  return line;
}

export type ComposerPlaceholderPick = { chatId: string; line: string };

/** Keeps the earlier pick while the chat is the same, so typing and re-renders never change the line. */
export function resolveComposerPlaceholder({
  current,
  chatId,
  random,
}: {
  current: ComposerPlaceholderPick | null;
  chatId: string;
  random: () => number;
}): ComposerPlaceholderPick {
  if (current !== null && current.chatId === chatId) return current;
  return { chatId, line: pickComposerPlaceholder(random) };
}

/** The line for the open chat. `threadListItem.id` is the local id, which survives the first send. */
export function useComposerPlaceholder(): string {
  const chatId = useAuiState(state => state.threadListItem.id);
  const [picked, setPicked] = useState<ComposerPlaceholderPick | null>(null);
  const next = resolveComposerPlaceholder({ current: picked, chatId, random: Math.random });
  if (next !== picked) setPicked(next);
  return next.line;
}
