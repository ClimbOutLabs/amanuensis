import { heldCallAuditText } from '../../../src/core/permissions/audit';
import { SERVER_SECRET_REASON } from '../../../src/core/permissions/searchHoldText';

const key = 'wsk-live-synthetic000111222333';
const cardNumber = '4111 1111 1111 1111';

function savedSearchCard(whyAskedAgain: string | null) {
  return {
    plain_what: `Search the web through web-search for: rotate ${key}, refund to ${cardNumber}`,
    plain_why: null,
    cannot_be_undone: null,
    why_asked_again: whyAskedAgain,
    destination: 'web-search',
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
  };
}

describe('heldCallAuditText', () => {
  it('prefers the stored audit text', () => {
    expect(
      heldCallAuditText({
        original_tool_name: 'web_search',
        audit_description: 'Search the web through web-search',
        tier3_card: savedSearchCard(null),
      }),
    ).toBe('Search the web through web-search');
  });

  it.each([
    ['Held for approval: it contains a secret this server holds.', `Held because ${SERVER_SECRET_REASON}.`],
    ['Held for approval: it contains a card number.', 'Held because it contains a card number.'],
    [null, 'Held because it needed approval.'],
  ])('names the saved reason %s, never the query, for a saved search card', (why, expected) => {
    const text = heldCallAuditText({ original_tool_name: 'web_search', tier3_card: savedSearchCard(why) });
    expect(text).toBe(`Search the web through web-search. ${expected}`);
    expect(text).not.toContain(key);
    expect(text).not.toContain(cardNumber);
  });

  it('describes any search provider call without its card sentence', () => {
    const text = heldCallAuditText({
      original_tool_name: 'fetch_page',
      search_provider_call: true,
      tier3_card: { ...savedSearchCard(null), plain_what: `Open a page about ${key}` },
    });
    expect(text).toBe('Search the web through web-search. Held because it needed approval.');
  });

  it('keeps the card sentence for any other call', () => {
    expect(
      heldCallAuditText({
        original_tool_name: 'send_note',
        tier3_card: { ...savedSearchCard(null), plain_what: 'Send a note to Ana', destination: 'mail' },
      }),
    ).toBe('Send a note to Ana');
  });
});
