import { extractSandboxArtifactsFromMessage, parseSandboxArtifacts } from '../../../src/core/sandbox/sandboxArtifacts';

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
