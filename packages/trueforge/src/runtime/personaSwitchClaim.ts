import type { ModelMessageEvent } from '@truefoundry/trueforge-core/core';

/** Whether a persona switch really ran in this turn; a reply may only say so when it did. */
export class PersonaSwitchLog {
  #switched = false;

  markSwitched(): void {
    this.#switched = true;
  }

  get switched(): boolean {
    return this.#switched;
  }
}

/** The exact line the persona tools ask the model to say after a switch. */
const SWITCH_CLAIM = /Now talking with [^\n.]+\./;
const EXISTING_PERSONA_LINE = /Using your existing [^\n.]+\.\s*/g;
const CLAIMED_NAME = /Now talking with ([^\n.]+)\./g;

export const UNSWITCHED_REPLY = 'I did not switch. Ask me again or pick the persona in the persona menu.';

/**
 * Text kept in the chat history. A real switch is stored as a host note, so the model has no assistant
 * sentence to copy. A claim with no switch behind it is replaced, so it is never learned either.
 */
export function switchTextForContext(input: { text: string; log: PersonaSwitchLog }): string {
  if (!SWITCH_CLAIM.test(input.text)) {
    return input.text;
  }
  if (!input.log.switched) {
    return UNSWITCHED_REPLY;
  }
  return input.text
    .replace(EXISTING_PERSONA_LINE, '')
    .replace(CLAIMED_NAME, '[The persona tool switched this chat to $1.]');
}

/** Replaces a reply that claims a switch no tool made. Returns undefined when the reply is fine. */
export function guardSwitchClaim(input: {
  output: ModelMessageEvent;
  log: PersonaSwitchLog;
}): ModelMessageEvent | undefined {
  if (input.log.switched) {
    return undefined;
  }
  const { content } = input.output;
  if (typeof content === 'string') {
    return SWITCH_CLAIM.test(content) ? { ...input.output, content: UNSWITCHED_REPLY } : undefined;
  }
  if (!Array.isArray(content) || !content.some(part => part.type === 'text' && SWITCH_CLAIM.test(part.text))) {
    return undefined;
  }
  return {
    ...input.output,
    content: content.map(part =>
      part.type === 'text' && SWITCH_CLAIM.test(part.text) ? { ...part, text: UNSWITCHED_REPLY } : part,
    ),
  };
}
