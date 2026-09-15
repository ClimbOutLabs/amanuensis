import { matchReplaceText } from '../../../src/core/sandbox/replaceTextDiagnostics';

describe('matchReplaceText', () => {
  it('returns exact_match for a unique exact occurrence', () => {
    const result = matchReplaceText({ fileContent: 'a\nfoo\nb', oldText: 'foo' });
    expect(result.status).toBe('exact_match');
  });

  it('rejects a repeated exact occurrence as ambiguous by default', () => {
    const result = matchReplaceText({ fileContent: 'foo\nbar\nfoo', oldText: 'foo' });
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.rejection).toMatch(/received/u);
      expect(result.rejection).toMatch(/expected/u);
      expect(result.rejection).toContain('matches 2 locations');
    }
  });

  it('accepts a repeated exact occurrence when replaceAll is true (bulk replace)', () => {
    const result = matchReplaceText({ fileContent: 'foo\nbar\nfoo', oldText: 'foo', replaceAll: true });
    expect(result.status).toBe('exact_match');
  });

  it('still rejects a no-match request when replaceAll is true', () => {
    const result = matchReplaceText({ fileContent: 'foo\nbar\nfoo', oldText: 'missing', replaceAll: true });
    expect(result.status).toBe('no_match');
  });

  it('returns no_match with a diagnostic when nothing matches exactly', () => {
    const result = matchReplaceText({ fileContent: 'function a() {}\n', oldText: 'function b() {}' });
    expect(result.status).toBe('no_match');
    if (result.status === 'no_match') {
      expect(result.rejection).toMatch(/received/u);
      expect(result.rejection).toMatch(/expected/u);
    }
  });

  it('includes the file path in the rejection when given one', () => {
    const result = matchReplaceText({
      fileContent: 'function a() {}\n',
      oldText: 'function b() {}',
      path: 'src/example.ts',
    });
    expect(result.status).toBe('no_match');
    if (result.status === 'no_match') {
      expect(result.rejection).toContain('src/example.ts');
    }
  });

  it('never applies a whitespace-only difference — a drifted indent rejects as no_match', () => {
    // Previously this was fuzzy-matched and applied with a note; the host must now reject it and
    // point at the real passage instead of substituting it.
    const fileContent =
      'function getSettings() {\n  const settings = {\n    debug: true,\n  };\n  return settings;\n}\n';
    const oldText = '  const settings = {\n    debug:  true,\n  };';
    const result = matchReplaceText({ fileContent, oldText, path: 'src/config.ts' });
    expect(result.status).toBe('no_match');
    if (result.status === 'no_match') {
      expect(result.rejection).toMatch(/received/u);
      expect(result.rejection).toMatch(/expected/u);
      // The diagnostic names the nearest passage's line range and shows its text so the model
      // can copy old_text from the file exactly, rather than the host guessing at a substitute.
      expect(result.rejection).toContain('Nearest passage in src/config.ts');
      expect(result.rejection).toContain('debug: true,');
    }
  });

  it('never applies a CRLF-vs-LF difference — a CRLF file rejects LF old_text as no_match', () => {
    const fileContent = 'function test() {\r\n  return 42;\r\n}\r\n';
    const oldText = 'function test() {\n  return 42;\n}';
    const result = matchReplaceText({ fileContent, oldText });
    expect(result.status).toBe('no_match');
  });

  it('locates the nearest passage and shows a compact line-level diff against what was sent', () => {
    const fileContent = 'function setup() {\n  console.log(1);\n}\n';
    const oldText = 'function setup() {\n  console.log(2);\n}';
    const result = matchReplaceText({ fileContent, oldText, path: 'src/setup.ts' });
    expect(result.status).toBe('no_match');
    if (result.status === 'no_match') {
      expect(result.rejection).toContain('lines 1-3');
      expect(result.rejection).toContain('- ');
      expect(result.rejection).toContain('+ ');
    }
  });

  it('says so and hints a re-read when nothing scores close enough to suggest a correction', () => {
    const result = matchReplaceText({
      fileContent: 'entirely unrelated content\nwith no resemblance at all\n',
      oldText: 'const totallyDifferentThing = 12345;',
      path: 'src/other.ts',
    });
    expect(result.status).toBe('no_match');
    if (result.status === 'no_match') {
      expect(result.rejection).toMatch(/received/u);
      expect(result.rejection).toMatch(/expected/u);
      expect(result.rejection).toContain("old_text's first line");
      expect(result.rejection).toContain('Re-read src/other.ts');
    }
  });

  describe('exact_match reports which bytes actually matched', () => {
    it('matches old_text verbatim when it occurs in the file as-is', () => {
      const result = matchReplaceText({ fileContent: 'a\nfoo\nb', oldText: 'foo' });
      expect(result.status).toBe('exact_match');
      if (result.status === 'exact_match') {
        expect(result.matchedText).toBe('foo');
      }
    });
  });

  describe('a uniform line-number gutter is tried only after old_text verbatim, never both silently', () => {
    it('prefers the verbatim match when old_text (which happens to look like a gutter) occurs as-is and its unguttered reading does not occur separately', () => {
      // "1: foo\n2: bar" is itself real, uniquely-occurring file content here, and the file has
      // no separate unguttered "foo\nbar" passage for the stripped reading to redirect to — the
      // host must use old_text verbatim rather than stripping it. See finding "Numbered code can
      // redirect replacements".
      const fileContent = 'items:\n1: foo\n2: bar\ndone\n';
      const result = matchReplaceText({ fileContent, oldText: '1: foo\n2: bar' });
      expect(result.status).toBe('exact_match');
      if (result.status === 'exact_match') {
        expect(result.matchedText).toBe('1: foo\n2: bar');
      }
    });

    it('falls back to the gutter-stripped form only when the verbatim text does not match', () => {
      const fileContent = 'function setup() {\n  const value = 42;\n}\n';
      const result = matchReplaceText({ fileContent, oldText: '212 | const value = 42;' });
      expect(result.status).toBe('exact_match');
      if (result.status === 'exact_match') {
        expect(result.matchedText).toBe('const value = 42;');
      }
    });

    it('rejects as ambiguous, naming both candidates, when the verbatim text and the stripped form each match somewhere', () => {
      // "1: foo\n2: bar" occurs verbatim once, and the un-numbered "foo\nbar" it would strip to
      // also occurs once elsewhere — both readings genuinely match something, so the host must
      // say so rather than silently pick one. See finding "Numbered code can redirect
      // replacements".
      const fileContent = 'foo\nbar\n\n1: foo\n2: bar\n';
      const ambiguous = matchReplaceText({ fileContent, oldText: '1: foo\n2: bar' });
      expect(ambiguous.status).toBe('ambiguous');
      if (ambiguous.status === 'ambiguous') {
        expect(ambiguous.rejection).toMatch(/received/u);
        expect(ambiguous.rejection).toMatch(/expected/u);
        expect(ambiguous.rejection).toContain('taken literally');
        expect(ambiguous.rejection).toContain('gutter stripped');
      }
    });

    it('never strips a gutter across a numbered list whose numbers are not strictly consecutive', () => {
      const fileContent = 'items:\n1: apple\n5: banana\n';
      const result = matchReplaceText({ fileContent, oldText: '1: apple\n5: banana' });
      expect(result.status).toBe('exact_match');
      if (result.status === 'exact_match') {
        expect(result.matchedText).toBe('1: apple\n5: banana');
      }
    });

    it('strips the gutter even when old_text ends in a trailing newline', () => {
      const fileContent = 'function setup() {\na();\nb();\n}\n';
      const result = matchReplaceText({ fileContent, oldText: '212: a();\n213: b();\n' });
      expect(result.status).toBe('exact_match');
      if (result.status === 'exact_match') {
        expect(result.matchedText).toBe('a();\nb();\n');
      }
    });
  });

  it('does not exhibit quadratic behavior on large files with repeated lines (regression test)', () => {
    // With a file of ~200,000 identical lines and old_text of similar lines, the diagnostic
    // builder must score candidates cheaply on per-line matches before materializing and diffing,
    // otherwise it becomes quadratic and times out. The cheap-scoring approach keeps this well
    // under 2000ms.
    const repeatedLine = 'const x = 1;\n';
    const largeFileContent = repeatedLine.repeat(200000);
    const oldText = (repeatedLine.repeat(1000) + 'const x = 999;\n').slice(0, -1); // Same lines + different last line
    const path = 'large-file.ts';

    const startTime = Date.now();
    const result = matchReplaceText({ fileContent: largeFileContent, oldText, path });
    const elapsed = Date.now() - startTime;

    expect(result.status).toBe('no_match');
    if (result.status === 'no_match') {
      expect(result.rejection).toContain(path);
      expect(result.rejection).toContain('Nearest passage');
      expect(result.rejection).toContain('Diff');
    }
    // Assert wall time is well under 2000ms to ensure the cheap-scoring optimization is working
    expect(elapsed).toBeLessThan(2000);
  });

  it('does not discard a passage two characters away in favor of decoys with more equal lines (regression test)', () => {
    // "A" is the rarest line of old_text in the file, so it anchors the search. Nine decoy blocks
    // each pair "A" with a huge mismatch on the following line — cheap equal-line counting alone
    // would rank those decoys above the real near-miss, since each decoy still shares two exactly
    // equal lines ("P" and "A") with old_text while the near-miss shares only one ("A"). The
    // lower-bound-on-edit-distance ranking must prefer the near-miss instead, since two
    // one-character line differences (P/p, S/s) cost far less than one huge mismatched line.
    const oldText = 'P\nA\nS';
    const hugeMismatchLine = 'X'.repeat(500);
    let decoys = '';
    for (let i = 0; i < 9; i++) {
      decoys += `P\nA\n${hugeMismatchLine}_decoy_${String(i)}\n`;
    }
    const nearMissBlock = 'p\nA\ns\n';
    // Enough standalone "P" and "S" lines that both occur more often than "A" (10 occurrences:
    // nine decoys plus the near-miss block), so selectAnchorLine picks "A" as the rarest line.
    const standalonePs = 'P\n'.repeat(6);
    const standaloneSs = 'S\n'.repeat(12);
    const fileContent = decoys + standalonePs + standaloneSs + nearMissBlock;

    const result = matchReplaceText({ fileContent, oldText, path: 'near-miss.ts' });

    expect(result.status).toBe('no_match');
    if (result.status === 'no_match') {
      expect(result.rejection).toContain('p\nA\ns');
      expect(result.rejection).not.toContain('decoy');
    }
  });

  describe('the nearest-passage diagnostic anchors on the most distinctive line, not always the first', () => {
    it('does not report the wrong passage when the first line is common but a later line differs', () => {
      // Both candidate blocks share the same first line; only the diagnostic anchored on the
      // rarer, more distinctive second line can tell them apart and report the actually-nearest
      // one. See finding "Misses can cite the wrong passage".
      const fileContent =
        'function handler(request) {\n' +
        '  return respondWithSuccess(request);\n' +
        '}\n\n' +
        'function handler(request) {\n' +
        '  return respondWithFailureAndLog(request);\n' +
        '}\n';
      const oldText = 'function handler(request) {\n  return respondWithFailureAndLog(request, extra);\n}';
      const result = matchReplaceText({ fileContent, oldText, path: 'src/handlers.ts' });
      expect(result.status).toBe('no_match');
      if (result.status === 'no_match') {
        expect(result.rejection).toContain('lines 5-7');
        expect(result.rejection).toContain('respondWithFailureAndLog');
      }
    });

    it('shows both candidates when two passages score within a small margin of each other', () => {
      // The distinctive anchor line "const shared = compute();" occurs twice, each time paired
      // with a following line that differs from old_text's by exactly one character — the two
      // candidate passages are equally close, so both must be shown rather than only one.
      const fileContent =
        'const shared = compute();\nconst delta = 1;\n\nconst shared = compute();\nconst delta = 2;\n';
      const oldText = 'const shared = compute();\nconst delta = 9;';
      const result = matchReplaceText({ fileContent, oldText, path: 'src/values.ts' });
      expect(result.status).toBe('no_match');
      if (result.status === 'no_match') {
        expect(result.rejection).toContain('Nearest passage in src/values.ts');
        expect(result.rejection).toContain('An equally close candidate exists at');
      }
    });
  });
});
