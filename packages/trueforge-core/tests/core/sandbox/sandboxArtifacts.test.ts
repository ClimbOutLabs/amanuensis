import {
  extractSandboxArtifactsFromMessage,
  normalizeSandboxArtifactBlocks,
  parseSandboxArtifacts,
} from '../../../src/core/sandbox/sandboxArtifacts';

describe('parseSandboxArtifacts', () => {
  it('parses tfy markdown-link pairs', () => {
    expect(parseSandboxArtifacts('[sample.js](/tmp/sample.js)\n[notes.txt](/tmp/notes.txt)')).toEqual([
      { name: 'sample.js', path: '/tmp/sample.js' },
      { name: 'notes.txt', path: '/tmp/notes.txt' },
    ]);
  });

  it('strips a leading sandbox_artifacts prefix', () => {
    expect(parseSandboxArtifacts('sandbox_artifacts\n[a.py](/tmp/a.py)')).toEqual([
      { name: 'a.py', path: '/tmp/a.py' },
    ]);
  });

  it('falls back to name: path lines', () => {
    expect(parseSandboxArtifacts('report.pdf: /sandbox/out/report.pdf')).toEqual([
      { name: 'report.pdf', path: '/sandbox/out/report.pdf' },
    ]);
  });

  it('parses "name (path)" lines', () => {
    expect(parseSandboxArtifacts('Lily James tribute video (/opt/tf/workspace/tribute.mp4)')).toEqual([
      { name: 'Lily James tribute video', path: '/opt/tf/workspace/tribute.mp4' },
    ]);
  });

  it('parses a bulleted "- name: path" line', () => {
    expect(parseSandboxArtifacts('- report.pdf: /sandbox/out/report.pdf')).toEqual([
      { name: 'report.pdf', path: '/sandbox/out/report.pdf' },
    ]);
  });

  it('parses a bare absolute path, using the basename as the name', () => {
    expect(parseSandboxArtifacts('/opt/tf/workspace/tribute.mp4')).toEqual([
      { name: 'tribute.mp4', path: '/opt/tf/workspace/tribute.mp4' },
    ]);
  });

  it('parses a path followed by a description', () => {
    expect(parseSandboxArtifacts('/opt/tf/workspace/tribute.mp4 - the finished tribute video')).toEqual([
      { name: 'the finished tribute video', path: '/opt/tf/workspace/tribute.mp4' },
    ]);
  });

  it('parses multiple loose-format lines together', () => {
    expect(
      parseSandboxArtifacts(
        ['Lily James tribute video (/opt/tf/workspace/tribute.mp4)', '/opt/tf/workspace/notes.txt'].join('\n'),
      ),
    ).toEqual([
      { name: 'Lily James tribute video', path: '/opt/tf/workspace/tribute.mp4' },
      { name: 'notes.txt', path: '/opt/tf/workspace/notes.txt' },
    ]);
  });

  it('returns no artifacts when nothing parses', () => {
    expect(parseSandboxArtifacts('not an artifact')).toEqual([]);
  });

  it('keeps a trailing dot when stripping it would leave no extension', () => {
    expect(parseSandboxArtifacts('/opt/tf/x/report.')).toEqual([{ name: 'report.', path: '/opt/tf/x/report.' }]);
  });

  it('strips a sentence-ending period that follows a real extension', () => {
    expect(parseSandboxArtifacts('The file is at /opt/tf/workspace/notes.txt.')).toEqual([
      { name: 'The file is at', path: '/opt/tf/workspace/notes.txt' },
    ]);
  });

  it('uses the last parenthesized absolute path and keeps earlier parens in the name', () => {
    expect(parseSandboxArtifacts('foo (bar) (/opt/tf/a.mp4)')).toEqual([{ name: 'foo (bar)', path: '/opt/tf/a.mp4' }]);
  });

  it('falls through to no match when the last parenthesized group is not a path', () => {
    expect(parseSandboxArtifacts('foo (bar) (baz)')).toEqual([]);
  });
});

describe('extractSandboxArtifactsFromMessage', () => {
  it('extracts and parses a single fence from a full assistant message', () => {
    const message = [
      'Here is your file:',
      '',
      '```sandbox_artifacts',
      '[Lily James tribute video](/opt/tf/workspace/tribute.mp4)',
      '```',
      '',
      'Let me know if you need anything else.',
    ].join('\n');
    expect(extractSandboxArtifactsFromMessage(message)).toEqual([
      { name: 'Lily James tribute video', path: '/opt/tf/workspace/tribute.mp4' },
    ]);
  });

  it('concatenates artifacts across multiple fences, in order', () => {
    const message = [
      '```sandbox_artifacts',
      '[a.txt](/tmp/a.txt)',
      '```',
      'some prose',
      '```sandbox_artifacts',
      '[b.txt](/tmp/b.txt)',
      '```',
    ].join('\n');
    expect(extractSandboxArtifactsFromMessage(message)).toEqual([
      { name: 'a.txt', path: '/tmp/a.txt' },
      { name: 'b.txt', path: '/tmp/b.txt' },
    ]);
  });

  it('returns an empty array when the message has no sandbox_artifacts fence', () => {
    expect(extractSandboxArtifactsFromMessage('Just a plain reply, no files.')).toEqual([]);
  });

  it('handles CRLF line endings after the fence marker', () => {
    const message = '```sandbox_artifacts\r\n[a.txt](/tmp/a.txt)\r\n```';
    expect(extractSandboxArtifactsFromMessage(message)).toEqual([{ name: 'a.txt', path: '/tmp/a.txt' }]);
  });
});

const CHART_LINK = '[Weekly food budget chart](/egress/weekly_food_budget.pdf)';
const CHART = { name: 'Weekly food budget chart', path: '/egress/weekly_food_budget.pdf' };
const CANONICAL_CHART = ['```sandbox_artifacts', CHART_LINK, '```'].join('\n');

/** Shapes self-hosted models actually emit; each one still declares the chart. */
const LOOSE_BLOCKS: Record<string, string> = {
  'glued to the end of a sentence': `The chart is ready. \`\`\`sandbox_artifacts\n${CHART_LINK}\n\`\`\``,
  'indented four spaces': `The chart is ready.\n\n    \`\`\`sandbox_artifacts\n    ${CHART_LINK}\n    \`\`\``,
  'wrapped in another fence': `\`\`\`\`markdown\n\`\`\`sandbox_artifacts\n${CHART_LINK}\n\`\`\`\n\`\`\`\``,
  'written on one line': `The chart is ready.\n\n\`\`\`sandbox_artifacts ${CHART_LINK} \`\`\``,
  'spelled with a hyphen and capitals': `The chart is ready.\n\n\`\`\`Sandbox-Artifacts\n${CHART_LINK}\n\`\`\``,
  'fenced with tildes': `The chart is ready.\n\n~~~sandbox_artifacts\n${CHART_LINK}\n~~~`,
};

describe('extractSandboxArtifactsFromMessage on loosely formatted blocks', () => {
  for (const [shape, message] of Object.entries(LOOSE_BLOCKS)) {
    it(`finds the file when the block is ${shape}`, () => {
      expect(extractSandboxArtifactsFromMessage(message)).toEqual([CHART]);
    });
  }

  it('finds a block the finished message never closed', () => {
    expect(extractSandboxArtifactsFromMessage(`Done.\n\n\`\`\`sandbox_artifacts\n${CHART_LINK}\n`)).toEqual([CHART]);
  });
});

describe('normalizeSandboxArtifactBlocks', () => {
  for (const [shape, message] of Object.entries(LOOSE_BLOCKS)) {
    it(`turns a block ${shape} into one well-formed fence`, () => {
      const normalized = normalizeSandboxArtifactBlocks({ text: message, complete: true });
      expect(normalized.endsWith(`${CANONICAL_CHART}\n`)).toBe(true);
      expect(normalized.split('sandbox_artifacts')).toHaveLength(2);
      expect(normalized).not.toContain('````');
    });
  }

  it('leaves a message with no block untouched', () => {
    expect(normalizeSandboxArtifactBlocks({ text: 'No files here.', complete: true })).toBe('No files here.');
  });

  it('drops a block that names no file', () => {
    expect(normalizeSandboxArtifactBlocks({ text: 'Done.\n\n```sandbox_artifacts\n\n```', complete: true })).toBe(
      'Done.',
    );
  });

  it('hides a block that is still streaming in, and shows it once the message is complete', () => {
    const partial = `Done.\n\n\`\`\`sandbox_artifacts\n${CHART_LINK}\n`;
    expect(normalizeSandboxArtifactBlocks({ text: partial, complete: false })).toBe('Done.');
    expect(normalizeSandboxArtifactBlocks({ text: partial, complete: true })).toBe(`Done.\n\n${CANONICAL_CHART}\n`);
  });

  it('gathers several blocks into one card at the end', () => {
    const message =
      '```sandbox_artifacts\n[a.txt](/tmp/a.txt)\n```\nMiddle text.\n```sandbox_artifacts\n[b.txt](/tmp/b.txt)\n```';
    expect(normalizeSandboxArtifactBlocks({ text: message, complete: true })).toBe(
      '\nMiddle text.\n\n```sandbox_artifacts\n[a.txt](/tmp/a.txt)\n[b.txt](/tmp/b.txt)\n```\n',
    );
  });
});

describe('unclosed blocks in finished messages', () => {
  it('keeps the prose that follows a block the finished message never closed', () => {
    const message = [
      'Done.',
      '',
      '```sandbox_artifacts',
      CHART_LINK,
      '',
      'That chart covers the week from Monday to Sunday.',
    ].join('\n');
    expect(extractSandboxArtifactsFromMessage(message)).toEqual([CHART]);
    const normalized = normalizeSandboxArtifactBlocks({ text: message, complete: true });
    expect(normalized).toContain('That chart covers the week from Monday to Sunday.');
    expect(normalized.endsWith(`${CANONICAL_CHART}\n`)).toBe(true);
  });

  it('does not treat a link in the prose after an unclosed block as a file', () => {
    const message = [
      'Done.',
      '',
      '```sandbox_artifacts',
      CHART_LINK,
      '',
      'See [the notes](https://example.com/notes) for details.',
    ].join('\n');
    expect(extractSandboxArtifactsFromMessage(message)).toEqual([CHART]);
    const normalized = normalizeSandboxArtifactBlocks({ text: message, complete: true });
    expect(normalized).toContain('See [the notes](https://example.com/notes) for details.');
    expect(normalized.endsWith(`${CANONICAL_CHART}\n`)).toBe(true);
  });

  it('keeps the text after an unclosed marker that names no file', () => {
    const message = ['Done.', '', '```sandbox_artifacts', 'Everything is in the folder I mentioned earlier.'].join(
      '\n',
    );
    expect(extractSandboxArtifactsFromMessage(message)).toEqual([]);
    const normalized = normalizeSandboxArtifactBlocks({ text: message, complete: true });
    expect(normalized).toContain('Everything is in the folder I mentioned earlier.');
    expect(normalized).not.toContain('sandbox_artifacts');
  });

  it('keeps hiding everything after an unclosed marker while the message is still streaming', () => {
    const partial = ['Done.', '', '```sandbox_artifacts', CHART_LINK, '', 'Still writing this part.'].join('\n');
    expect(normalizeSandboxArtifactBlocks({ text: partial, complete: false })).toBe('Done.');
  });
});

describe('markers inside other fences', () => {
  const EXAMPLE_IN_MARKDOWN_FENCE = [
    'Use this in your reply:',
    '',
    '```markdown',
    'Put this at the end:',
    '```sandbox_artifacts',
    '[fake.pdf](/tmp/fake.pdf)',
    '```',
    '```',
  ].join('\n');

  const EXAMPLE_IN_LONGER_FENCE = [
    '````markdown',
    'Put this at the end:',
    '```sandbox_artifacts',
    '[fake.pdf](/tmp/fake.pdf)',
    '```',
    '````',
  ].join('\n');

  it('extracts nothing from a marker quoted as an example in a fence that holds other text', () => {
    expect(extractSandboxArtifactsFromMessage(EXAMPLE_IN_MARKDOWN_FENCE)).toEqual([]);
    expect(extractSandboxArtifactsFromMessage(EXAMPLE_IN_LONGER_FENCE)).toEqual([]);
  });

  it('leaves a marker quoted as an example inside another fence untouched', () => {
    expect(normalizeSandboxArtifactBlocks({ text: EXAMPLE_IN_MARKDOWN_FENCE, complete: true })).toBe(
      EXAMPLE_IN_MARKDOWN_FENCE,
    );
    expect(normalizeSandboxArtifactBlocks({ text: EXAMPLE_IN_LONGER_FENCE, complete: true })).toBe(
      EXAMPLE_IN_LONGER_FENCE,
    );
  });

  it('still finds a real block that comes after a closed example fence', () => {
    const message = [
      'Here is an example:',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '```sandbox_artifacts',
      CHART_LINK,
      '```',
    ].join('\n');
    expect(extractSandboxArtifactsFromMessage(message)).toEqual([CHART]);
    const normalized = normalizeSandboxArtifactBlocks({ text: message, complete: true });
    expect(normalized).toContain('const x = 1;');
    expect(normalized.endsWith(`${CANONICAL_CHART}\n`)).toBe(true);
  });

  it('still finds the file when an artifacts block is the only content of the fence around it, blank lines aside', () => {
    const message = ['````markdown', '', '```sandbox_artifacts', CHART_LINK, '```', '', '````'].join('\n');
    expect(extractSandboxArtifactsFromMessage(message)).toEqual([CHART]);
    const normalized = normalizeSandboxArtifactBlocks({ text: message, complete: true });
    expect(normalized.endsWith(`${CANONICAL_CHART}\n`)).toBe(true);
    expect(normalized).not.toContain('````');
  });
});
