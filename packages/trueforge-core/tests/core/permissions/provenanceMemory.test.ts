import {
  carriedPrivateDetails,
  emptyChatProvenance,
  recordUntrustedText,
  steeredDestinations,
} from '../../../src/core/permissions/provenance';
import { steeredDestinationSay } from '../../../src/core/permissions/searchHoldText';

describe('text read earlier and saved to memory', () => {
  it('keeps the persons details, as the host notes on their chat do', () => {
    const provenance = emptyChatProvenance();
    recordUntrustedText({ provenance, text: 'Call me on maya.k@example.com or +1 415 555 0132.', source: 'memory' });

    expect(provenance.read_content).toBe(true);
    expect(
      carriedPrivateDetails({ provenance, values: ['send to maya.k@example.com and 415-555-0132'] }).sort(),
    ).toEqual(['4155550132', 'maya.k@example.com']);
  });

  it('says on the card that the address was read earlier and saved to memory', () => {
    const provenance = emptyChatProvenance();
    recordUntrustedText({
      provenance,
      text: 'Offer at https://shop.example/deal from deals@shop.example',
      source: 'memory',
    });
    const [address, link] = steeredDestinations({
      provenance,
      addresses: ['deals@shop.example'],
      values: ['https://shop.example/deal'],
      reply_sender: null,
    });

    expect(address?.origin.source).toBe('memory');
    expect(
      steeredDestinationSay({
        assistant: 'Aman',
        destinations: [
          { who: 'deals@shop.example', kind: 'address', source: 'memory' },
          { who: 'https://shop.example/deal', kind: 'link', source: link?.origin.source ?? 'other' },
        ],
      }),
    ).toBe(
      'This goes to deals@shop.example, whose address Aman read earlier and saved to memory. ' +
        'This goes to https://shop.example/deal, which Aman read earlier and saved to memory.',
    );
  });
});
