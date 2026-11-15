import type { TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { isAgentInputUserMessage, isFileContentPart, isHostWrappedText } from '@truefoundry/trueforge-core/core';

/**
 * Full (uncapped) text of every user message in a create-turn input, concatenated in order and
 * joined with a blank line, or `''` when there is none. A turn's input can carry several user
 * messages (e.g. queued follow-ups sent before the previous turn finished); retention must not
 * silently drop any but the first.
 */
export function extractUserMessageText(input: TurnInputItem[] | undefined): string {
  const userMessages = input?.filter(isAgentInputUserMessage) ?? [];
  return userMessages
    .map(message =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter(part => !isFileContentPart(part))
            .map(part => part.text)
            .filter(text => !isHostWrappedText(text))
            .join(' '),
    )
    .join('\n\n');
}
