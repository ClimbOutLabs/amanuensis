import {
  buildExecResultShape,
  classifyExecStatus,
  EXITED_NOTE,
  NO_MATCHES_NOTE,
} from '../../../src/core/sandbox/execResultSemantics';

describe('classifyExecStatus', () => {
  describe('exit 0 (success)', () => {
    it('treats exit 0 as ok for any command', () => {
      expect(classifyExecStatus('grep pattern file', 0)).toBe('ok');
      expect(classifyExecStatus('echo hello', 0)).toBe('ok');
      expect(classifyExecStatus('custom-command', 0)).toBe('ok');
      expect(classifyExecStatus('cat file | grep pattern', 0)).toBe('ok');
    });
  });

  describe('grep exit 1 (no matches)', () => {
    it('treats grep exit 1 as ok', () => {
      expect(classifyExecStatus('grep pattern file', 1)).toBe('ok');
    });

    it('treats egrep exit 1 as ok', () => {
      expect(classifyExecStatus('egrep pattern file', 1)).toBe('ok');
    });

    it('treats fgrep exit 1 as ok', () => {
      expect(classifyExecStatus('fgrep pattern file', 1)).toBe('ok');
    });

    it('treats rg exit 1 as ok', () => {
      expect(classifyExecStatus('rg pattern file', 1)).toBe('ok');
    });

    it('treats a bare, literal git grep exit 1 as ok', () => {
      expect(classifyExecStatus('git grep pattern', 1)).toBe('ok');
    });

    it('treats ag exit 1 as ok', () => {
      expect(classifyExecStatus('ag pattern file', 1)).toBe('ok');
    });
  });

  describe('diff exit 1 (differences found)', () => {
    it('treats diff exit 1 as ok', () => {
      expect(classifyExecStatus('diff file1 file2', 1)).toBe('ok');
    });
  });

  describe('grep exit 2 (a real error)', () => {
    it('treats grep exit 2 as exited, not ok', () => {
      expect(classifyExecStatus('grep pattern file', 2)).toBe('exited');
    });
  });

  describe('generic exit 1 on a bare simple command', () => {
    it('treats exit 1 as exited for unknown commands - never "failed"', () => {
      expect(classifyExecStatus('custom-cmd', 1)).toBe('exited');
      expect(classifyExecStatus('make', 1)).toBe('exited');
    });

    it('treats a bare command grep as exited, not ok - the search table is bare-name only', () => {
      expect(classifyExecStatus('command grep pattern file', 1)).toBe('exited');
    });
  });

  describe('bare git', () => {
    it('still treats git grep as ok only when grep is the literal first argument', () => {
      expect(classifyExecStatus('git grep pattern', 1)).toBe('ok');
    });

    it('treats a bare git command as exited, not ok', () => {
      expect(classifyExecStatus('git status', 1)).toBe('exited');
    });

    it('treats git grep behind a global option as exited, not ok - the table is bare-name only', () => {
      expect(classifyExecStatus('git -C /workspace grep absent', 1)).toBe('exited');
    });

    it('treats git followed by something other than grep as exited', () => {
      expect(classifyExecStatus('git -C /workspace log', 1)).toBe('exited');
    });
  });

  describe('wrapper commands are never a bare simple command', () => {
    it('treats env wrapping a search command as exited, not ok', () => {
      expect(classifyExecStatus('env X=1 grep absent file', 1)).toBe('exited');
    });

    it('treats env wrapping an unrecognized command as exited', () => {
      expect(classifyExecStatus('env FOO=bar make', 1)).toBe('exited');
    });

    it('treats env alone as exited', () => {
      expect(classifyExecStatus('env', 1)).toBe('exited');
    });

    it('treats env -S wrapping a search command as exited', () => {
      expect(classifyExecStatus("env -S 'grep absent /dev/null'", 1)).toBe('exited');
    });

    it('treats timeout wrapping a search command as exited', () => {
      expect(classifyExecStatus('timeout 5 grep absent file', 1)).toBe('exited');
    });

    it('treats sudo wrapping a search command as exited', () => {
      expect(classifyExecStatus('sudo grep absent file', 1)).toBe('exited');
    });

    it('treats bare find as exited - it was never in the search/diff table', () => {
      expect(classifyExecStatus('find /missing -name "*.txt"', 1)).toBe('exited');
    });
  });

  describe('complex shell constructs are always "exited", never guessed at as ok', () => {
    it('marks piped commands as exited', () => {
      expect(classifyExecStatus('grep pattern file | head -5', 1)).toBe('exited');
    });

    it('marks a pipeline ending in a recognized search command as exited', () => {
      expect(classifyExecStatus('cat file | grep pattern', 1)).toBe('exited');
    });

    it('marks sequential execution (semicolon) as exited', () => {
      expect(classifyExecStatus('grep x /dev/null; false', 1)).toBe('exited');
    });

    it('marks logical AND as exited', () => {
      expect(classifyExecStatus('cd /workspace && grep absent file', 1)).toBe('exited');
    });

    it('marks logical OR as exited', () => {
      expect(classifyExecStatus('grep pattern file || echo "not found"', 1)).toBe('exited');
    });

    it('marks input redirect as exited', () => {
      expect(classifyExecStatus('grep pattern < file', 1)).toBe('exited');
    });

    it('marks output redirect as exited', () => {
      expect(classifyExecStatus('grep pattern file > results', 1)).toBe('exited');
    });

    it('marks command substitution as exited', () => {
      expect(classifyExecStatus('grep pattern $(find . -name "*.txt")', 1)).toBe('exited');
    });

    it('marks backtick substitution as exited', () => {
      expect(classifyExecStatus('grep pattern `find . -name "*.txt"`', 1)).toBe('exited');
    });

    it('still treats a simple grep command as ok', () => {
      expect(classifyExecStatus('grep pattern file', 1)).toBe('ok');
    });

    it('allows quoted arguments containing pipe characters (still a simple command)', () => {
      expect(classifyExecStatus("rg 'foo|bar' file", 1)).toBe('ok');
    });

    it('allows double-quoted arguments containing pipe characters (still a simple command)', () => {
      expect(classifyExecStatus('rg "foo|bar" file', 1)).toBe('ok');
    });

    it('allows quoted arguments containing semicolons (still a simple command)', () => {
      expect(classifyExecStatus("grep 'a;b' file", 1)).toBe('ok');
    });

    it('allows quoted arguments containing redirect characters (still a simple command)', () => {
      expect(classifyExecStatus("rg 'output > input' file", 1)).toBe('ok');
    });

    it('allows escaped characters in double quotes (still a simple command)', () => {
      expect(classifyExecStatus('grep "\\$variable" file', 1)).toBe('ok');
    });

    it('treats a single-quoted pipe as literal (still a simple command)', () => {
      expect(classifyExecStatus("grep 'a\\|b' file", 1)).toBe('ok');
    });

    it('treats an unquoted escaped pipe as literal (still a simple command)', () => {
      expect(classifyExecStatus('grep a\\|b file', 1)).toBe('ok');
    });

    it('treats an escaped dollar in double quotes as literal (still a simple command)', () => {
      expect(classifyExecStatus('grep "a\\$b" file', 1)).toBe('ok');
    });

    it('still marks a truly unescaped pipe as exited', () => {
      expect(classifyExecStatus('grep a|b file', 1)).toBe('exited');
    });

    it('does not crash on a trailing unescaped backslash', () => {
      expect(classifyExecStatus('grep pattern file\\', 1)).toBe('ok');
    });

    it('marks command substitution in double quotes as exited', () => {
      expect(classifyExecStatus('grep "$(false)" pattern file', 1)).toBe('exited');
    });

    it('treats single-quoted command substitution as literal (still a simple command)', () => {
      expect(classifyExecStatus("grep '$(false)' file", 1)).toBe('ok');
    });

    it('marks backticks in double quotes as exited', () => {
      expect(classifyExecStatus('grep "`cat /dev/null`" file', 1)).toBe('exited');
    });

    it('treats single-quoted backticks as literal (still a simple command)', () => {
      expect(classifyExecStatus("grep '`cat /dev/null`' file", 1)).toBe('ok');
    });

    it('marks process substitution as exited', () => {
      expect(classifyExecStatus('grep pattern <(find . -name "*.txt")', 1)).toBe('exited');
    });

    it('marks a process substitution used as an argument value as exited, not ok', () => {
      // A failing subprocess inside a process substitution argument (e.g. `<(sh -c 'exit 7')`)
      // must not let a search command's own benign exit-1 semantics apply.
      expect(classifyExecStatus("grep pattern <(sh -c 'exit 7')", 1)).toBe('exited');
    });

    it('marks a here-document as exited', () => {
      expect(classifyExecStatus('grep pattern <<EOF\nfoo\nEOF', 1)).toBe('exited');
    });

    it('marks a backgrounded command as exited', () => {
      expect(classifyExecStatus('grep pattern file &', 1)).toBe('exited');
    });

    it('marks arithmetic expansion as exited', () => {
      expect(classifyExecStatus('grep pattern file$((1+1))', 1)).toBe('exited');
    });

    it('allows a parameter expansion in double quotes (still a simple command)', () => {
      expect(classifyExecStatus('grep "$PATTERN" file', 1)).toBe('ok');
    });

    it('marks an unparseable command as exited', () => {
      expect(classifyExecStatus('grep pattern (', 1)).toBe('exited');
    });

    it('marks a negated pipeline as exited', () => {
      expect(classifyExecStatus('! cat file | grep pattern', 1)).toBe('exited');
    });
  });

  describe('nested substitutions inside parameter expansion defaults', () => {
    it('marks a command substitution nested in a parameter default as exited', () => {
      expect(classifyExecStatus('grep pattern "${UNSET:-$(printf /dev/null; false)}"', 1)).toBe('exited');
    });

    it('marks an arithmetic expansion nested in a parameter default as exited', () => {
      expect(classifyExecStatus('grep pattern "${UNSET:-$((1+1))}"', 1)).toBe('exited');
    });

    it('marks a command substitution nested via the := operator as exited', () => {
      expect(classifyExecStatus('grep pattern "${UNSET:=$(false)}"', 1)).toBe('exited');
    });

    it('still allows a parameter expansion default with no nested substitution', () => {
      expect(classifyExecStatus('grep pattern "${UNSET:-fallback}"', 1)).toBe('ok');
    });
  });
});

describe('buildExecResultShape', () => {
  describe('when sandbox succeeds', () => {
    it('sets status ok and exit_code 0 for successful execution', () => {
      const result = buildExecResultShape(0, 'echo hello', 'hello', true);

      expect(result).toEqual({
        status: 'ok',
        exit_code: 0,
        error_summary: null,
        success: true,
        note: null,
      });
    });

    it('sets status ok and an explicit no-matches note for a bare grep with no matches (exit 1)', () => {
      const result = buildExecResultShape(1, 'grep pattern file', '', true);

      expect(result).toEqual({
        status: 'ok',
        exit_code: 1,
        error_summary: null,
        success: true,
        note: NO_MATCHES_NOTE,
      });
    });

    it('sets the no-matches note for rg exit 1 as well', () => {
      const result = buildExecResultShape(1, 'rg pattern file', '', true);

      expect(result.note).toBe(NO_MATCHES_NOTE);
    });

    it('sets status ok and an explicit no-matches note for a bare, literal git grep with no matches (exit 1)', () => {
      const result = buildExecResultShape(1, 'git grep pattern', '', true);

      expect(result).toEqual({
        status: 'ok',
        exit_code: 1,
        error_summary: null,
        success: true,
        note: NO_MATCHES_NOTE,
      });
    });

    it('sets status ok for diff exit 1 (differences found)', () => {
      const result = buildExecResultShape(1, 'diff file1 file2', 'file1 differs from file2', true);

      expect(result).toEqual({
        status: 'ok',
        exit_code: 1,
        error_summary: 'file1 differs from file2',
        success: true,
        note: null,
      });
    });

    it('sets status exited for env wrapping a search command with no matches (exit 1)', () => {
      const result = buildExecResultShape(1, 'env X=1 grep absent file', '', true);

      expect(result).toEqual({
        status: 'exited',
        exit_code: 1,
        error_summary: null,
        success: true,
        note: EXITED_NOTE,
      });
    });

    it('sets status exited for `find` with no matches (exit 1) - find is not in the search table', () => {
      const result = buildExecResultShape(1, 'find /missing -name "*.txt"', '', true);

      expect(result).toEqual({
        status: 'exited',
        exit_code: 1,
        error_summary: null,
        success: true,
        note: EXITED_NOTE,
      });
    });

    it('sets status exited for `command grep` (a bare simple command, but not a table name)', () => {
      const result = buildExecResultShape(1, 'command grep pattern file', '', true);

      expect(result.status).toBe('exited');
      expect(result.note).toBe(EXITED_NOTE);
    });

    it('sets status exited for a pipeline ending in a recognized search command (exit 1)', () => {
      const result = buildExecResultShape(1, 'cat f | grep pattern', '', true);

      expect(result.status).toBe('exited');
      expect(result.note).toBe(EXITED_NOTE);
    });

    it('sets status exited for a search command with a redirect (exit 1)', () => {
      const result = buildExecResultShape(1, 'grep pattern < file', '', true);

      expect(result.status).toBe('exited');
      expect(result.note).toBe(EXITED_NOTE);
    });

    it('sets status exited for a list where a search command follows a failed command', () => {
      const result = buildExecResultShape(1, 'false && grep pattern file', '', true);

      expect(result.status).toBe('exited');
      expect(result.note).toBe(EXITED_NOTE);
    });

    it('reports exited with the sentence when the first command in a pipeline fails and the last is grep returning 1', () => {
      const result = buildExecResultShape(1, 'false | grep pattern', 'grep: found nothing', true);

      expect(result).toEqual({
        status: 'exited',
        exit_code: 1,
        error_summary: 'grep: found nothing',
        success: true,
        note: EXITED_NOTE,
      });
    });

    it('sets status exited (never "failed") for a generic simple command with a non-zero exit', () => {
      const output = 'error: invalid regex\npattern not found';
      const result = buildExecResultShape(1, 'custom-cmd', output, true);

      expect(result).toEqual({
        status: 'exited',
        exit_code: 1,
        error_summary: 'pattern not found',
        success: true,
        note: EXITED_NOTE,
      });
    });

    it('extracts last non-empty line as error_summary for an exited simple command', () => {
      const output = 'first error line\nsecond error line\n\n';
      const result = buildExecResultShape(1, 'make', output, true);

      expect(result.status).toBe('exited');
      expect(result.error_summary).toBe('second error line');
    });

    it('sets error_summary to null when output is empty and exit is 0', () => {
      const result = buildExecResultShape(0, 'grep pattern', '', true);

      expect(result.error_summary).toBeNull();
    });

    it('sets error_summary to null when output is empty and exit is 1 for an unknown command', () => {
      const result = buildExecResultShape(1, 'unknown-cmd', '', true);

      expect(result.error_summary).toBeNull();
      expect(result.status).toBe('exited');
    });

    it('sets status exited (never "failed") for grep exit 2 (a real error)', () => {
      const result = buildExecResultShape(2, 'grep pattern file', 'grep: file: No such file', true);

      expect(result.status).toBe('exited');
      expect(result.exit_code).toBe(2);
      expect(result.error_summary).toBe('grep: file: No such file');
      expect(result.note).toBe(EXITED_NOTE);
    });
  });

  describe('when sandbox fails', () => {
    it('sets status failed with exit_code -1 when sandbox infrastructure fails', () => {
      const result = buildExecResultShape(0, 'echo hello', 'Connection lost', false);

      expect(result).toEqual({
        status: 'failed',
        exit_code: -1,
        error_summary: 'Connection lost',
        success: false,
        note: null,
      });
    });

    it('provides default error message for empty output on sandbox failure', () => {
      const result = buildExecResultShape(0, 'echo hello', '', false);

      expect(result.status).toBe('failed');
      expect(result.exit_code).toBe(-1);
      expect(result.error_summary).toBe('Sandbox infrastructure failure');
      expect(result.success).toBe(false);
      expect(result.note).toBeNull();
    });
  });
});
