import { parseSimpleShellCommand } from '../../../src/core/sandbox/simpleShellCommand';

describe('parseSimpleShellCommand', () => {
  it('splits a plain command into name and arguments', () => {
    expect(parseSimpleShellCommand('grep -rn pattern src')).toEqual({ name: 'grep', args: ['-rn', 'pattern', 'src'] });
  });

  it('removes quotes and keeps their contents literal', () => {
    expect(parseSimpleShellCommand(`rg 'foo|bar' "a;b > c" file`)).toEqual({
      name: 'rg',
      args: ['foo|bar', 'a;b > c', 'file'],
    });
    expect(parseSimpleShellCommand(`grep '$(false)' '\`x\`'`)).toEqual({ name: 'grep', args: ['$(false)', '`x`'] });
  });

  it('handles backslash escapes', () => {
    expect(parseSimpleShellCommand('grep a\\|b file')).toEqual({ name: 'grep', args: ['a|b', 'file'] });
    expect(parseSimpleShellCommand('grep "a\\$b" file')).toEqual({ name: 'grep', args: ['a$b', 'file'] });
    expect(parseSimpleShellCommand('grep "a\\nb"')).toEqual({ name: 'grep', args: ['a\\nb'] });
    expect(parseSimpleShellCommand('grep x file\\')).toEqual({ name: 'grep', args: ['x', 'file\\'] });
  });

  it('allows parameter expansions without substitutions', () => {
    expect(parseSimpleShellCommand('grep "$PATTERN" $HOME/file "${UNSET:-fallback}" $1')).not.toBeNull();
    expect(parseSimpleShellCommand('grep x "${A:-${B:-c}}"')).not.toBeNull();
  });

  it.each([
    ['a pipeline', 'cat file | grep x'],
    ['a list', 'grep x; false'],
    ['an and-list', 'cd /w && grep x'],
    ['an or-list', 'grep x || echo no'],
    ['an input redirect', 'grep x < file'],
    ['an output redirect', 'grep x > out'],
    ['a here-document', 'grep x <<EOF\nfoo\nEOF'],
    ['a background job', 'grep x &'],
    ['a subshell', '(grep x)'],
    ['a stray parenthesis', 'grep x ('],
    ['a command substitution', 'grep $(find .)'],
    ['a backtick substitution', 'grep `find .`'],
    ['a substitution in double quotes', 'grep "$(false)" file'],
    ['a backtick in double quotes', 'grep "`cat f`" file'],
    ['an arithmetic expansion', 'grep x file$((1+1))'],
    ['a process substitution', 'grep x <(find .)'],
    ['a substitution in a parameter default', 'grep x "${U:-$(false)}"'],
    ['arithmetic in a parameter default', 'grep x "${U:-$((1+1))}"'],
    ['a substitution behind :=', 'grep x "${U:=$(false)}"'],
    ['a backtick in a parameter default', 'grep x ${U:-`false`}'],
    ['ANSI-C quoting', "grep $'a\\tb' file"],
    ['a leading assignment', 'LC_ALL=C grep x'],
    ['a negation', '! grep x'],
    ['a compound command', 'if grep x; then :; fi'],
    ['a comment', 'grep x # note'],
    ['an unterminated single quote', "grep 'x"],
    ['an unterminated double quote', 'grep "x'],
    ['an unterminated parameter expansion', 'grep ${X'],
    ['an empty command', '   '],
  ])('returns null for %s', (_label, command) => {
    expect(parseSimpleShellCommand(command)).toBeNull();
  });
});
