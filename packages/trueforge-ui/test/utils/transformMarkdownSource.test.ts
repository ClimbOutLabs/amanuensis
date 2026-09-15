import { describe, expect, it } from 'vitest';

import { scanMarkdownSegments, transformMarkdownSource } from '@/utils/transformMarkdownSource.js';

describe('scanMarkdownSegments', () => {
  it('returns a single prose segment when there is no code', () => {
    expect(scanMarkdownSegments('hello world')).toEqual([{ text: 'hello world', inCode: false }]);
  });

  it('tags a fenced code block as code, including its fence lines', () => {
    const segments = scanMarkdownSegments('before\n```\ncode<br>\n```\nafter');
    expect(segments).toEqual([
      { text: 'before\n', inCode: false },
      { text: '```\ncode<br>\n```\n', inCode: true },
      { text: 'after', inCode: false },
    ]);
  });

  it('tags an inline code span as code', () => {
    const segments = scanMarkdownSegments('see `a‑b` here');
    expect(segments).toEqual([
      { text: 'see ', inCode: false },
      { text: '`a‑b`', inCode: true },
      { text: ' here', inCode: false },
    ]);
  });

  it('treats an unclosed backtick run as plain text, not code', () => {
    const segments = scanMarkdownSegments('a ` b');
    expect(segments.every(segment => !segment.inCode)).toBe(true);
    expect(segments.map(segment => segment.text).join('')).toBe('a ` b');
  });

  it('requires a matching backtick run length to close an inline span', () => {
    // Opens with a single backtick; the `` `` run in the middle is two backticks and does not
    // close it, so it becomes part of the span's content, and the trailing single backtick closes it.
    const segments = scanMarkdownSegments('`a``b`');
    expect(segments).toEqual([{ text: '`a``b`', inCode: true }]);
  });

  it('recognises a closing fence with more backticks than the opening fence', () => {
    const segments = scanMarkdownSegments('```\ncode\n````');
    expect(segments).toEqual([{ text: '```\ncode\n````', inCode: true }]);
  });

  it('does not close a fence with fewer backticks than the opening fence', () => {
    const segments = scanMarkdownSegments('````\n``\ncode\n````');
    expect(segments).toEqual([{ text: '````\n``\ncode\n````', inCode: true }]);
  });

  it('tags a tilde-fenced code block as code', () => {
    const segments = scanMarkdownSegments('before\n~~~\ncode<br>\n~~~\nafter');
    expect(segments).toEqual([
      { text: 'before\n', inCode: false },
      { text: '~~~\ncode<br>\n~~~\n', inCode: true },
      { text: 'after', inCode: false },
    ]);
  });

  it('does not let a backtick fence close a tilde fence or vice versa', () => {
    const segments = scanMarkdownSegments('~~~\n```\ncode\n~~~');
    expect(segments).toEqual([{ text: '~~~\n```\ncode\n~~~', inCode: true }]);
  });

  it('rejects a backtick fence opener whose info string contains a backtick', () => {
    // Per CommonMark, a backtick-fenced code block's info string cannot itself contain a
    // backtick, so this is not a valid fence and the tag on the next line stays live prose.
    const segments = scanMarkdownSegments('```foo`bar\ntext<br>');
    expect(segments.every(segment => !segment.inCode)).toBe(true);
  });

  it('allows a backtick in a tilde fence info string', () => {
    const segments = scanMarkdownSegments('~~~foo`bar\ncode\n~~~');
    expect(segments).toEqual([{ text: '~~~foo`bar\ncode\n~~~', inCode: true }]);
  });

  it('tags a fenced code block nested in a blockquote as code', () => {
    const segments = scanMarkdownSegments('> ```\n> foo<br>\n> ```');
    expect(segments).toEqual([{ text: '> ```\n> foo<br>\n> ```', inCode: true }]);
  });

  it('closes a fence correctly with CRLF line endings', () => {
    const segments = scanMarkdownSegments('```\r\ncode\r\n```\r\nafter<br>');
    expect(segments).toEqual([
      { text: '```\r\ncode\r\n```\r\n', inCode: true },
      { text: 'after<br>', inCode: false },
    ]);
  });

  it('carries an inline code span across a line break', () => {
    const segments = scanMarkdownSegments('see `literal\n<br>` here');
    expect(segments).toEqual([
      { text: 'see ', inCode: false },
      { text: '`literal\n<br>`', inCode: true },
      { text: ' here', inCode: false },
    ]);
  });

  it('does not let an inline code span cross a blank line', () => {
    const segments = scanMarkdownSegments('see `unterminated\n\nmore<br>');
    expect(segments.every(segment => !segment.inCode)).toBe(true);
    expect(segments.map(segment => segment.text).join('')).toBe('see `unterminated\n\nmore<br>');
  });

  it('does not treat an escaped backtick as an inline-code delimiter', () => {
    const segments = scanMarkdownSegments('\\`literal <br>\\`');
    expect(segments.every(segment => !segment.inCode)).toBe(true);
    expect(segments.map(segment => segment.text).join('')).toBe('\\`literal <br>\\`');
  });

  it('still recognizes a real code span after an escaped backtick', () => {
    const segments = scanMarkdownSegments('\\`a `code<br>` b');
    expect(segments).toEqual([
      { text: '\\`a ', inCode: false },
      { text: '`code<br>`', inCode: true },
      { text: ' b', inCode: false },
    ]);
  });

  it('does not close an inline code span on a backslash-preceded backtick (Qodo #4)', () => {
    // Per CommonMark, backslashes are literal once inside a code span: the backtick immediately
    // after "foo\" still closes the span, so the tag right after it is prose, not code.
    const segments = scanMarkdownSegments('`foo\\` after<br>');
    expect(segments).toEqual([
      { text: '`foo\\`', inCode: true },
      { text: ' after<br>', inCode: false },
    ]);
  });

  it('treats a CRLF blank line as ending an unterminated inline code span (Qodo #5)', () => {
    // A backtick after the CRLF blank line must not be allowed to close the span opened before
    // it; the blank line ends the block first, per CommonMark, regardless of line-ending style.
    const segments = scanMarkdownSegments('see `unterminated\r\n\r\nmore<br>`');
    expect(segments.every(segment => !segment.inCode)).toBe(true);
    expect(segments.map(segment => segment.text).join('')).toBe('see `unterminated\r\n\r\nmore<br>`');
  });
});

describe('transformMarkdownSource', () => {
  it('rewrites a leading unicode-hyphen bullet (U+2011) to an ASCII hyphen', () => {
    expect(transformMarkdownSource('‑ item one\n‑ item two')).toBe('- item one\n- item two');
  });

  it('rewrites a leading unicode-hyphen bullet (U+2010) to an ASCII hyphen', () => {
    expect(transformMarkdownSource('‐ item')).toBe('- item');
  });

  it('preserves leading whitespace before a rewritten bullet', () => {
    expect(transformMarkdownSource('  ‑ nested item')).toBe('  - nested item');
  });

  it('does not touch a unicode hyphen that is not followed by a space', () => {
    expect(transformMarkdownSource('a‑b at line start')).toBe('a‑b at line start');
  });

  it('leaves a literal <br> tag untouched (rendering is handled by rehype-raw, not this transform)', () => {
    expect(transformMarkdownSource('a<br>b')).toBe('a<br>b');
    expect(transformMarkdownSource('a<BR/>b<br />c')).toBe('a<BR/>b<br />c');
  });

  it('leaves a unicode-hyphen bullet untouched inside a fenced code block', () => {
    const source = '```\nfoo<br>bar\n‑ item\n```';
    expect(transformMarkdownSource(source)).toBe(source);
  });

  it('leaves a unicode-hyphen bullet untouched inside an inline code span', () => {
    expect(transformMarkdownSource('see `‑ item` here')).toBe('see `‑ item` here');
  });

  it('inserts a newline between a <br> tag and a bullet that immediately follows it, then rewrites the bullet', () => {
    expect(transformMarkdownSource('note <br>‑ Unusual fatigue')).toBe('note <br>\n- Unusual fatigue');
  });

  it('is case-insensitive and whitespace-tolerant when matching the <br> tag before a bullet', () => {
    expect(transformMarkdownSource('note <BR />‑ item')).toBe('note <BR />\n- item');
  });

  it('does not insert a newline after <br> when nothing that looks like a bullet follows', () => {
    expect(transformMarkdownSource('a<br>b')).toBe('a<br>b');
  });

  it('does not insert a second newline when a bullet already starts its own line after <br>', () => {
    expect(transformMarkdownSource('a<br>\n‑ item')).toBe('a<br>\n- item');
  });

  it('leaves a tilde-fenced code block untouched', () => {
    const source = '~~~\nfoo<br>bar\n‑ item\n~~~';
    expect(transformMarkdownSource(source)).toBe(source);
  });

  it('leaves content inside a fenced block nested in a blockquote untouched', () => {
    const source = '> ```\n> foo<br>‑ item\n> ```';
    expect(transformMarkdownSource(source)).toBe(source);
  });

  it('does not rewrite a <br>-then-bullet pattern inside a fenced code block', () => {
    const source = '```\n<br>‑ item\n```';
    expect(transformMarkdownSource(source)).toBe(source);
  });

  it('handles a <br>-then-bullet pattern with CRLF line endings elsewhere in the source', () => {
    expect(transformMarkdownSource('first\r\nnote <br>‑ item')).toBe('first\r\nnote <br>\n- item');
  });

  describe('math delimiters', () => {
    it('rewrites a top-level display math block to a blank-line-wrapped $$ block', () => {
      // No leading blank line when the opener starts the source: there is nothing above it to
      // separate the block from (see the "avoid adding an extra leading newline at file start"
      // comment on rewriteDisplayMath).
      const result = transformMarkdownSource('\\[ \\text{Volume}=\\pi r^2 h \\]');
      expect(result).toBe('$$\n\\text{Volume}=\\pi r^2 h\n$$\n\n');
    });

    it('rewrites inline math to a double-dollar run', () => {
      const result = transformMarkdownSource('The area is \\( \\pi r^2 \\) exactly.');
      expect(result).toBe('The area is $$\\pi r^2$$ exactly.');
    });

    it('rewrites multiple inline math spans in the same line', () => {
      const result = transformMarkdownSource('\\(a\\) plus \\(b\\) equals \\(c\\)');
      expect(result).toBe('$$a$$ plus $$b$$ equals $$c$$');
    });

    it('rewrites a top-level display math block that spans multiple lines', () => {
      // Same file-start rule as above: no leading blank line when the opener is at offset 0.
      const result = transformMarkdownSource('\\[\n  x = 1\n\\]');
      expect(result).toBe('$$\nx = 1\n$$\n\n');
    });

    it('leaves text with no delimiters untouched', () => {
      expect(transformMarkdownSource('plain prose, nothing to see')).toBe('plain prose, nothing to see');
    });

    it('leaves escaped dollar signs untouched', () => {
      expect(transformMarkdownSource('It costs \\$5 today.')).toBe('It costs \\$5 today.');
    });

    it('leaves an unpaired \\[ untouched (e.g. a literal escaped bracket in prose)', () => {
      const input = 'See the note \\[ref needed] below.';
      expect(transformMarkdownSource(input)).toBe(input);
    });

    it('leaves an unpaired \\( untouched', () => {
      const input = 'A stray \\( with no closer.';
      expect(transformMarkdownSource(input)).toBe(input);
    });

    it('does not rewrite \\[ \\] inside a fenced code block', () => {
      const input = '```\n\\[ \\text{x} \\]\n```';
      expect(transformMarkdownSource(input)).toBe(input);
    });

    it('does not rewrite \\( \\) inside a fenced code block', () => {
      const input = '```\n\\( x \\)\n```';
      expect(transformMarkdownSource(input)).toBe(input);
    });

    it('does not rewrite delimiters inside an inline code span', () => {
      const input = 'see `\\( x \\)` here';
      expect(transformMarkdownSource(input)).toBe(input);
    });

    it('rewrites math outside a code span while leaving the span itself untouched', () => {
      const input = 'inline `code \\( x \\) code` then real math \\( y \\) after';
      const result = transformMarkdownSource(input);
      expect(result).toBe('inline `code \\( x \\) code` then real math $$y$$ after');
    });

    it('trims whitespace inside the delimiters when rewriting', () => {
      expect(transformMarkdownSource('\\(   x + y   \\)')).toBe('$$x + y$$');
    });

    it('leaves a mid-line \\[ \\] pair literal (CommonMark escaped brackets, a citation)', () => {
      const input = 'See reference \\[1\\] for details.';
      expect(transformMarkdownSource(input)).toBe(input);
    });

    it('leaves a mid-line \\[ \\] pair literal (an escaped array index)', () => {
      const input = 'Access it as array\\[i\\] in the loop.';
      expect(transformMarkdownSource(input)).toBe(input);
    });

    it('keeps a $$ block inside a list item, using the item indentation as the continuation prefix', () => {
      const result = transformMarkdownSource('- item\n  \\[ x^2 \\]\n  more');
      expect(result).toBe('- item\n  $$\n  x^2\n  $$\n  more');
    });

    it('keeps a $$ block inside a blockquote, prefixing every line with "> "', () => {
      const result = transformMarkdownSource('> quote\n> \\[ x^2 \\]\n> more');
      expect(result).toBe('> quote\n> $$\n> x^2\n> $$\n> more');
    });

    it('keeps a $$ block inside a nested list item, replacing the marker with spaces', () => {
      const result = transformMarkdownSource('- a\n  - \\[ y \\]');
      expect(result).toBe('- a\n  - $$\n    y\n    $$');
    });

    it('leaves \\( a \\[ b \\] c \\) unchanged (overlapping delimiter pairs are not math)', () => {
      const input = '\\( a \\[ b \\] c \\)';
      expect(transformMarkdownSource(input)).toBe(input);
    });

    it('leaves \\( a \\[ b \\) c \\] unchanged (overlapping delimiter pairs are not math)', () => {
      const input = '\\( a \\[ b \\) c \\]';
      expect(transformMarkdownSource(input)).toBe(input);
    });
  });
});
