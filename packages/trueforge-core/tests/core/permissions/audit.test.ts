import { heldCallAuditText } from '../../../src/core/permissions/audit';

const key = 'wsk-live-synthetic000111222333';
const cardNumber = '4111 1111 1111 1111';

function savedSearchCard(whyAskedAgain: string | null) {
  return {
    plain_what: `Search the web through the search provider for: rotate ${key}, refund to ${cardNumber}`,
    copy: null,
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
        audit_description: 'Search the web through the search provider',
        tier3_card: savedSearchCard(null),
      }),
    ).toBe('Search the web through the search provider');
  });

  it.each([
    [
      'Held for approval: it contains a secret this server holds.',
      'This sends something that looks like a password or key.',
    ],
    ['Held for approval: it contains a card number.', 'It checked with you first.'],
    [null, 'It checked with you first.'],
  ])('names the saved reason %s, never the query, for a saved search card', (why, expected) => {
    const text = heldCallAuditText({ original_tool_name: 'web_search', tier3_card: savedSearchCard(why) });
    expect(text).toBe(`Search the web through the search provider. ${expected}`);
    expect(text).not.toContain(key);
    expect(text).not.toContain(cardNumber);
  });

  it('describes any search provider call without its card sentence', () => {
    const text = heldCallAuditText({
      original_tool_name: 'fetch_page',
      search_provider_call: true,
      tier3_card: { ...savedSearchCard(null), plain_what: `Open a page about ${key}` },
    });
    expect(text).toBe('Search the web through the search provider. It checked with you first.');
  });

  it('keeps the card sentence for any other call', () => {
    expect(
      heldCallAuditText({
        original_tool_name: 'send_note',
        tier3_card: { ...savedSearchCard(null), plain_what: 'Send a note to Ana', destination: 'mail' },
      }),
    ).toBe('Send a note to Ana');
  });

  it('keeps the reason the card asked, which the card shows on its own line', () => {
    const reason = 'This change sends an invitation to other people, so Aman always asks.';
    expect(
      heldCallAuditText({
        original_tool_name: 'create_event',
        tier3_card: {
          ...savedSearchCard(null),
          plain_what: 'Add "Harbour picnic" to your Google Calendar on Sat 8 Nov, 11:00 AM (Europe/London)?',
          copy: {
            headline: 'Add "Harbour picnic" to your Google Calendar on Sat 8 Nov, 11:00 AM (Europe/London)?',
            consequence: null,
            reason,
          },
          destination: null,
        },
      }),
    ).toBe(`Add "Harbour picnic" to your Google Calendar on Sat 8 Nov, 11:00 AM (Europe/London)? ${reason}`);
  });

  it('does not repeat a reason the card sentence already holds', () => {
    const reason = 'Aman found this link in a page it read, not from you.';
    expect(
      heldCallAuditText({
        original_tool_name: 'browser_click',
        tier3_card: {
          ...savedSearchCard(null),
          plain_what: `Click "Claim" on evil.example? ${reason}`,
          copy: { headline: 'Click "Claim" on evil.example?', consequence: null, reason },
          destination: 'evil.example',
        },
      }),
    ).toBe(`Click "Claim" on evil.example? ${reason}`);
  });
});
