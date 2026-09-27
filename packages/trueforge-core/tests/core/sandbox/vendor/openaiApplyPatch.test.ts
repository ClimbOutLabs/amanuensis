import { parseApplyPatchEnvelope } from '../../../../src/core/sandbox/vendor/openaiApplyPatch';

describe('parseApplyPatchEnvelope', () => {
  it('parses a well-formed envelope with add, delete, and update-with-move operations', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: path/add.py',
      '+abc',
      '+def',
      '*** Delete File: path/delete.py',
      '*** Update File: path/update.py',
      '*** Move to: path/update2.py',
      '@@ def f():',
      '-    pass',
      '+    return 123',
      '*** End Patch',
    ].join('\n');

    const result = parseApplyPatchEnvelope(patch);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.hunks).toEqual([
      { type: 'add', path: 'path/add.py', lines: ['abc', 'def'] },
      { type: 'delete', path: 'path/delete.py' },
      {
        type: 'update',
        path: 'path/update.py',
        movePath: 'path/update2.py',
        chunks: [
          {
            trailer: 'def f():',
            bodyLines: [
              { marker: '-', text: '    pass' },
              { marker: '+', text: '    return 123' },
            ],
            endOfFile: false,
          },
        ],
      },
    ]);
  });

  it('rejects an update hunk left empty when the next header arrives', () => {
    const patch = ['*** Begin Patch', '*** Update File: test.py', '*** End Patch'].join('\n');
    const result = parseApplyPatchEnvelope(patch);
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain("Update file hunk for path 'test.py' is empty");
  });

  it('accepts an envelope wrapped in a single-quoted heredoc', () => {
    const inner = ['*** Begin Patch', '*** Add File: a.txt', '+hi', '*** End Patch'].join('\n');
    const patch = `<<'EOF'\n${inner}\nEOF\n`;
    const result = parseApplyPatchEnvelope(patch);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.hunks).toEqual([{ type: 'add', path: 'a.txt', lines: ['hi'] }]);
  });

  it('rejects an envelope wrapped in mismatched heredoc quotes', () => {
    const inner = ['*** Begin Patch', '*** Add File: a.txt', '+hi', '*** End Patch'].join('\n');
    const patch = `<<"EOF'\n${inner}\nEOF\n`;
    const result = parseApplyPatchEnvelope(patch);
    expect(result.status).toBe('error');
  });

  it('captures a preamble Environment ID and keeps it out of the parsed hunks', () => {
    const patch = [
      '*** Begin Patch',
      '*** Environment ID: remote',
      '*** Add File: hello.txt',
      '+hello',
      '*** End Patch',
    ].join('\n');
    const result = parseApplyPatchEnvelope(patch);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.environmentId).toBe('remote');
    expect(result.hunks).toEqual([{ type: 'add', path: 'hello.txt', lines: ['hello'] }]);
  });

  it('rejects an empty Environment ID', () => {
    const patch = [
      '*** Begin Patch',
      '*** Environment ID:   ',
      '*** Add File: hello.txt',
      '+hello',
      '*** End Patch',
    ].join('\n');
    const result = parseApplyPatchEnvelope(patch);
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('environment_id cannot be empty');
  });

  it('preserves the "*** End of File" marker on a chunk', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      '+quux',
      '*** End of File',
      '',
      '*** End Patch',
    ].join('\n');
    const result = parseApplyPatchEnvelope(patch);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.hunks).toEqual([
      {
        type: 'update',
        path: 'file.txt',
        movePath: undefined,
        chunks: [{ trailer: undefined, bodyLines: [{ marker: '+', text: 'quux' }], endOfFile: true }],
      },
    ]);
  });

  it('rejects the first line not being "*** Begin Patch"', () => {
    const result = parseApplyPatchEnvelope('bad');
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toBe("The first line of the patch must be '*** Begin Patch'");
  });

  it('rejects the last line not being "*** End Patch"', () => {
    const result = parseApplyPatchEnvelope('*** Begin Patch\nbad');
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toBe("The last line of the patch must be '*** End Patch'");
  });
});
