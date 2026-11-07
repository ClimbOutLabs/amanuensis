import type { MailMessage } from '../../../../src/runtime/noticing/sources';
import type { MailWindow } from '../../../../src/runtime/noticing/watchers';

/** The messages of a window that was read; a test that expects mail fails on any other window. */
export function readMessages(window: MailWindow): MailMessage[] {
  if (window.status !== 'read') {
    throw new Error(`Expected a read window but it was ${window.status}`);
  }
  return window.messages;
}
