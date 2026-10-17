import { idsIn, MAX_REFERENCES, parseIdList } from '../../../../src/core/email/gmail/messageId';

const isMessageId = (value: string) => parseIdList({ value, max: 1 }) !== null;

describe('a message id', () => {
  it.each(['<a@example.com>', '<abc.def+tag@mail.example.com>', "<a!#$%&'*+/^_`{|}~-b@c.d>"])('accepts %s', value => {
    expect(isMessageId(value)).toBe(true);
  });

  it.each([
    'a@example.com',
    '<a@example.com',
    '<a b@example.com>',
    '<a@example.com> ',
    '<a(comment)@example.com>',
    '<"quoted"@example.com>',
    '<a@@example.com>',
    '<a..b@example.com>',
    '<.a@example.com>',
    '<=?utf-8?B?YQ==?=@example.com>',
    '<a@example.com>\r\n',
    '<>',
    '',
  ])('refuses %j', value => {
    expect(isMessageId(value)).toBe(false);
  });

  it('refuses an id over 250 characters and accepts one at the limit', () => {
    const at = (length: number) => `<${'a'.repeat(length - '<@b.c>'.length)}@b.c>`;
    expect(isMessageId(at(250))).toBe(true);
    expect(isMessageId(at(251))).toBe(false);
  });
});

describe('parseIdList', () => {
  it('reads ids separated by single spaces', () => {
    expect(parseIdList({ value: '<a@x.y> <b@x.y>', max: 20 })).toEqual(['<a@x.y>', '<b@x.y>']);
  });

  it.each(['<a@x.y>  <b@x.y>', ' <a@x.y>', '<a@x.y> ', '<a@x.y>,<b@x.y>', '<a@x.y> junk', ''])(
    'refuses a list that is not exactly ids and single spaces: %j',
    value => {
      expect(parseIdList({ value, max: 20 })).toBeNull();
    },
  );

  it('refuses more ids than the maximum', () => {
    const ids = (count: number) => Array.from({ length: count }, (_u, index) => `<${String(index)}@x.y>`).join(' ');
    expect(parseIdList({ value: ids(MAX_REFERENCES), max: MAX_REFERENCES })).toHaveLength(MAX_REFERENCES);
    expect(parseIdList({ value: ids(MAX_REFERENCES + 1), max: MAX_REFERENCES })).toBeNull();
    expect(parseIdList({ value: ids(2), max: 1 })).toBeNull();
  });
});

describe('idsIn', () => {
  it('keeps the valid ids of a header written however the sender liked and drops the rest', () => {
    expect(idsIn('<a@x.y>\n  <b@x.y>  junk (comment) <c d@x.y>')).toEqual(['<a@x.y>', '<b@x.y>']);
    expect(idsIn('')).toEqual([]);
  });
});
