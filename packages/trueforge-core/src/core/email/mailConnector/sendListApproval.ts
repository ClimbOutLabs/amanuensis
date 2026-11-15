/** Shown when the server will not add an address, so nothing is sent. The draft is kept. */
export const NEW_RECIPIENT_REFUSED =
  'Aman could not add this address to your send list, so nothing was sent. Your draft is still here. Cancel it, or ask Aman to save it as a draft.';

/** Shown when the sidecar has not loaded the updated list in time. The address is kept on the list. */
export const SEND_LIST_STILL_UPDATING = 'Aman is still updating your send list. Try sending again in a moment.';

/**
 * Shown when the person picked a different account on the card and that account has an address on
 * the email that is not on its own send list. Nothing is sent and nothing is added. A new address
 * can only be added from a card made for that account, so the person asks for the send again from
 * that account and gets that card.
 */
export const NEW_RECIPIENT_ACCOUNT_SWITCHED =
  'Aman did not send this email. The account you picked has an address on it that is not on the send list for that account, and a new address can only be added from a card for that account. Ask Aman to send it from that account, and you will be asked about the new address first.';
