import { useAuiState } from '@assistant-ui/react';

import { HELP_COMPOSER_PLACEHOLDER } from '../help/helpModel.js';
import { useOptionalHelp } from '../help/HelpProvider.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';

/** The agent builder's chat is for trying the draft agent, so its box asks for a test task. */
export const AGENT_BUILDER_COMPOSER_PLACEHOLDER = 'Give your agent a task to try.';

/** The everyday composer placeholders. The assistant asks these itself, so they never carry its name. */
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

/** Each chat's line, kept for the life of the page so remounts, chat switches and the first send keep it. */
const lineByChat = new Map<string, string>();

/** Returns the chat's line, drawing one the first time the chat is seen. */
export function resolveComposerPlaceholder({ chatId, random }: { chatId: string; random: () => number }): string {
  const existing = lineByChat.get(chatId);
  if (existing !== undefined) return existing;
  const line = pickComposerPlaceholder(random);
  lineByChat.set(chatId, line);
  return line;
}

/** The line for the open chat. `threadListItem.id` is the local id, which survives the first send. */
export function useComposerPlaceholder(): string {
  const chatId = useAuiState(state => state.threadListItem.id);
  const help = useOptionalHelp();
  const shell = useOptionalShellMode();
  // In the help chat the composer is the only place to type, so it carries the help hint.
  if (help !== null && help.isSessionFor(chatId)) return HELP_COMPOSER_PLACEHOLDER;
  if (shell?.mode.status === 'active' && shell.mode.isMutable && shell.mode.isCreateAgent) {
    return AGENT_BUILDER_COMPOSER_PLACEHOLDER;
  }
  return resolveComposerPlaceholder({ chatId, random: Math.random });
}
