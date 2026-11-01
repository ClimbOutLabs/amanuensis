import { extractCardFields } from '../../../src/core/permissions/extractorRegistry';

const MAIL_READS = [
  'list-messages',
  'search-messages',
  'get-message',
  'get-thread',
  'get-unread-count',
  'list-attachments',
  'fetch-attachment',
];

/** Words outside the read vocabulary, including a digit and a connector-style conjunction. */
const OUTSIDE_WORDS = ['zebra', 'kettle', 'and', 'wire', '2'];

function extract(tool_name: string) {
  return extractCardFields({ tool_name, canonical_params: { message_id: 'm1' }, tool_type: 'mcp' });
}

describe('connector read allow-list', () => {
  it.each(MAIL_READS)('%s is a read', name => {
    expect(extract(name).connector_read).toBe(true);
  });

  it('a read may carry any allowed word after its verb', () => {
    expect(extract('list-unread-messages-by-id').connector_read).toBe(true);
    expect(extract('get_mailbox_folder_headers').connector_read).toBe(true);
  });

  it.each(MAIL_READS.flatMap(name => OUTSIDE_WORDS.map(word => [name, word] as const)))(
    '%s with the word %s appended is never a read',
    (name, word) => {
      expect(extract(`${name}-${word}`).connector_read).toBe(false);
    },
  );

  it('a name whose first word is not a read verb is never a read', () => {
    expect(extract('messages-list').connector_read).toBe(false);
    expect(extract('send-message').connector_read).toBe(false);
  });
});
