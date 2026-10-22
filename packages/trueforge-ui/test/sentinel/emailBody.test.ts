import { describe, expect, it } from 'vitest';

import { countEmailWords, isLongEmailBody, splitEmailBody } from '@/sentinel/emailBody.js';

describe('splitEmailBody', () => {
  it('keeps plain text as one text segment, line breaks included', () => {
    expect(splitEmailBody('Hi Rui,\n\nSee you.')).toEqual([{ kind: 'text', text: 'Hi Rui,\n\nSee you.' }]);
  });

  it('splits out a fenced block as code, between text on either side', () => {
    expect(splitEmailBody('Run:\n```\n$ pnpm test\n```\nThen reply.')).toEqual([
      { kind: 'text', text: 'Run:' },
      { kind: 'code', text: '$ pnpm test' },
      { kind: 'text', text: 'Then reply.' },
    ]);
  });

  it('reads an unclosed fence as code to the end, not as stray backticks', () => {
    expect(splitEmailBody('Look:\n```\nls -la')).toEqual([
      { kind: 'text', text: 'Look:' },
      { kind: 'code', text: 'ls -la' },
    ]);
  });

  it('returns no segments for an empty message', () => {
    expect(splitEmailBody('')).toEqual([]);
  });
});

describe('countEmailWords', () => {
  it('counts the words of the whole message, across lines and paragraphs', () => {
    expect(countEmailWords('one two\n\nthree   four\nfive')).toBe(5);
  });

  it('counts nothing for a blank message', () => {
    expect(countEmailWords(' \n ')).toBe(0);
  });
});

describe('isLongEmailBody', () => {
  it('is long only past nine lines', () => {
    expect(isLongEmailBody(Array.from({ length: 9 }, () => 'x').join('\n'))).toBe(false);
    expect(isLongEmailBody(Array.from({ length: 10 }, () => 'x').join('\n'))).toBe(true);
  });
});
