import { accountNamesOfResult, mailboxesOfResult } from '../../../../src/core/email/mailConnector/mailToolResults';

const sent = { name: '[Gmail]/Sent Mail', delimiter: '/', flags: ['\\Sent'] };

describe('mailboxesOfResult', () => {
  it('reads the folders from a structured result, one text block per folder, or one block for the list', () => {
    expect(mailboxesOfResult({ structuredContent: { result: [sent] }, content: [] })).toEqual([sent]);
    expect(mailboxesOfResult({ content: [{ type: 'text', text: JSON.stringify(sent) }] })).toEqual([sent]);
    expect(mailboxesOfResult({ content: [{ type: 'text', text: JSON.stringify([sent]) }] })).toEqual([sent]);
  });

  it('leaves out an entry with no name and reads a missing delimiter or flag list as none', () => {
    const content = [{ type: 'text', text: JSON.stringify([{ delimiter: '/' }, { name: 'Receipts' }]) }];
    expect(mailboxesOfResult({ content })).toEqual([{ name: 'Receipts', delimiter: '', flags: [] }]);
  });
});

describe('accountNamesOfResult', () => {
  it('reads each account name once, in order', () => {
    const content = ['work', 'home', 'work'].map(account_name => ({
      type: 'text',
      text: JSON.stringify({ account_name }),
    }));
    expect(accountNamesOfResult({ content })).toEqual(['work', 'home']);
  });
});
