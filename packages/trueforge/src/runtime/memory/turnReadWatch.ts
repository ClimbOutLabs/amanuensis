import { turnReadOutsideText, type ContextMessage } from '@truefoundry/trueforge-core/core';

/**
 * Remembers, for one turn, whether outside text was read before the call being made now. It is told the context
 * before every model step, so a call is judged on what the model had seen when it wrote the call. Once a turn has
 * read outside text it stays read, even if a later summary drops the evidence. Until the first look, it counts as read.
 */
export class TurnReadWatch {
  #seen = false;
  #read = true;

  observe(context: readonly ContextMessage[]): void {
    const read = turnReadOutsideText(context);
    this.#read = this.#seen ? this.#read || read : read;
    this.#seen = true;
  }

  get readOutsideText(): boolean {
    return this.#read;
  }
}
