import { withArgvAsCommandLine } from '../../../../src/core/sandbox/provider/Provider';

describe('withArgvAsCommandLine', () => {
  test('a call without argv is unchanged', () => {
    const params = { sandboxId: 's', command: 'ls -la' };
    expect(withArgvAsCommandLine(params)).toBe(params);
  });

  test('an argv call becomes that program with each argument quoted', () => {
    expect(
      withArgvAsCommandLine({ sandboxId: 's', command: 'shown', argv: ['python3', 'a.py', "it's", '$(id)'] }),
    ).toEqual({ sandboxId: 's', command: `'python3' 'a.py' 'it'\\''s' '$(id)'` });
  });
});
