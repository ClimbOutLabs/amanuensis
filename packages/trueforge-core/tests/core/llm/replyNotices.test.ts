import { noticeAfter } from '../../../src/core/llm/replyNotices';

describe('noticeAfter', () => {
  it('sets a notice off with a paragraph break after plain text', () => {
    expect(noticeAfter({ text: 'Done.', notice: 'Note.' })).toBe('\n\nNote.');
  });

  it('adds one line break after text that ends with one', () => {
    expect(noticeAfter({ text: 'Done.\n', notice: 'Note.' })).toBe('\nNote.');
  });

  it('adds nothing before the notice after a paragraph break or with no text', () => {
    expect(noticeAfter({ text: 'Done.\n\n', notice: 'Note.' })).toBe('Note.');
    expect(noticeAfter({ text: '', notice: 'Note.' })).toBe('Note.');
  });
});
