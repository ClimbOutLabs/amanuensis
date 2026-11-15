import { personTypedText, turnReadOutsideText, type ContextMessage } from '@truefoundry/trueforge-core/core';

/** Why the page tools must not write this turn. */
export type TurnReadReason = 'read_outside_text' | 'memory_holds_outside_text';

/**
 * Remembers, for one turn, whether outside text has reached the model, so the page tools can refuse. Two things
 * count: text read before the call being made now (told the context before every model step, so a call is
 * judged on what the model had seen when it wrote it), and a memory block that holds recalled text which is not
 * the person's own words. Once either is true it stays true, even if a later summary drops the evidence. Until
 * the first look at the context, the turn counts as read.
 */
export class TurnReadWatch {
  #seen = false;
  #read = true;
  #blockHoldsOutside = false;
  #personText = '';

  observe(context: readonly ContextMessage[]): void {
    const read = turnReadOutsideText(context);
    this.#read = this.#seen ? this.#read || read : read;
    this.#seen = true;
    this.#personText = personTypedText(context);
  }

  /** What the person typed in the message this turn answers; empty until the first look at the context. */
  get personText(): string {
    return this.#personText;
  }

  noteBlock({ holdsOutsideText }: { holdsOutsideText: boolean }): void {
    this.#blockHoldsOutside ||= holdsOutsideText;
  }

  /** Why writing is off, or undefined when the turn holds only the person's own words. */
  get reason(): TurnReadReason | undefined {
    if (this.#read) {
      return 'read_outside_text';
    }
    return this.#blockHoldsOutside ? 'memory_holds_outside_text' : undefined;
  }
}
