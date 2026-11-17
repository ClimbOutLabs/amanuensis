import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { WINDOW_POWERSHELL_ARGS } from '../../src/window/launch.ts';
import { WINDOW_BOOTSTRAP, WINDOW_SCRIPT, WINDOW_SCRIPT_CAP } from '../../src/window/windowScript.ts';

const source = readFileSync(new URL('../../src/window/windowScript.ts', import.meta.url), 'utf8');
const xaml = WINDOW_SCRIPT.slice(WINDOW_SCRIPT.indexOf("$xaml = @'"), WINDOW_SCRIPT.indexOf("'@"));

test('the script and its start line are fixed text: nothing is put into them when the program runs', () => {
  // No value is spliced into either text, and each is one literal.
  assert.ok(!source.includes('${'));
  assert.equal(source.split('String.raw`').length, 2);
  assert.equal(source.split('`').length, 3);
  assert.ok(!/\bfunction\b|=>/.test(source.replaceAll(WINDOW_SCRIPT, '')));
});

test('the words PowerShell is started with match the golden file', () => {
  const golden = readFileSync(new URL('../golden/window-start.txt', import.meta.url), 'utf8');
  assert.equal(`${WINDOW_POWERSHELL_ARGS.join('\n')}\n`, golden);
  assert.equal(WINDOW_POWERSHELL_ARGS.at(-1), WINDOW_BOOTSTRAP);
  // No policy is overridden, nothing is hidden or encoded, and PowerShell leaves the input alone.
  const flags = WINDOW_POWERSHELL_ARGS.slice(0, -1).join(' ');
  assert.equal(flags, '-NoProfile -NoLogo -NonInteractive -InputFormat None -Command');
});

test('the script fits what the start line will read and is plain ASCII', () => {
  assert.ok(new TextEncoder().encode(WINDOW_SCRIPT).length < WINDOW_SCRIPT_CAP);
  assert.ok(WINDOW_BOOTSTRAP.includes(`$l -gt ${String(WINDOW_SCRIPT_CAP)}`));
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(WINDOW_SCRIPT));
});

test('the script runs no text as code, loads nothing by name lookup, and touches no file or network', () => {
  const banned = [
    'Invoke-Expression',
    'iex',
    'ScriptBlock',
    'Invoke-Command',
    'Add-Type',
    'Import-Module',
    'New-Object',
    'Start-Process',
    'Start-Job',
    'Out-File',
    'Set-Content',
    'Add-Content',
    'Export-',
    'WebClient',
    'Invoke-WebRequest',
    'Invoke-RestMethod',
    'Net.Sockets',
    'NamedPipe',
    'Clipboard',
    'Write-Host',
    'Write-Output',
    'Start-Transcript',
    'ExecutionPolicy',
    '[IO.File]',
    'ConvertTo-SecureString',
    'ConvertFrom-SecureString',
    'PtrToString',
  ];
  for (const word of banned) {
    assert.ok(!new RegExp(`(^|[^A-Za-z])${word.replace(/[[\]\-.]/g, '\\$&')}`, 'i').test(WINDOW_SCRIPT), word);
  }
  assert.ok(WINDOW_SCRIPT.includes("$PSModuleAutoLoadingPreference = 'None'"));
  assert.ok(WINDOW_SCRIPT.includes("if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 4 }"));
  // Assemblies are loaded by their full signed names only.
  const loads = WINDOW_SCRIPT.match(/Assembly\]::Load\('[^']+'\)/g) ?? [];
  assert.equal(loads.length, 5);
  for (const load of loads) {
    assert.match(load, /Version=4\.0\.0\.0, Culture=neutral, PublicKeyToken=[0-9a-f]{16}'\)$/);
  }
  // The only addresses are the two names every window description starts with.
  assert.deepEqual(WINDOW_SCRIPT.match(/https?:\/\/[^"'\s]+/g), [
    'http://schemas.microsoft.com/winfx/2006/xaml/presentation',
    'http://schemas.microsoft.com/winfx/2006/xaml',
  ]);
});

test('the window description is parsed once, from fixed text, and holds nothing that reads or runs data', () => {
  assert.equal(WINDOW_SCRIPT.split('XamlReader').length, 2);
  assert.ok(WINDOW_SCRIPT.includes('$window = [Windows.Markup.XamlReader]::Parse($xaml)'));
  // The description is a single-quoted block, which PowerShell takes as it stands.
  assert.equal(WINDOW_SCRIPT.split("@'").length, 2);
  assert.equal(WINDOW_SCRIPT.split('$xaml').length, 3);
  assert.ok(xaml.length > 1000);
  for (const word of [
    '{',
    '}',
    'Binding',
    'NavigateUri',
    'Hyperlink',
    'Source=',
    'x:Class',
    'x:Code',
    'clr-namespace',
    'ObjectDataProvider',
    'Click=',
    'Frame',
    'WebBrowser',
    'Command=',
    'ResourceDictionary',
    '<!',
  ]) {
    assert.ok(!xaml.includes(word), word);
  }
});

test('what arrives from the setup program is only ever shown as plain text or read as a yes, a no or a number', () => {
  const rest = WINDOW_SCRIPT.replace(xaml, '');
  const uses = rest.match(/[^\n]*\$(?:m|w|row)\[[^\n]*/g) ?? [];
  assert.ok(uses.length > 15);
  const allowed = [
    /^\s*\$kind = \[string\]\$m\['t'\]$/,
    /^\s*\$w = \$m\['words'\]$/,
    /^\s*foreach \(\$row in \$m\['rows'\]\) \{$/,
    /^\s*\$S\.confirmClose = \[bool\]\$m\['confirmClose'\]$/,
    /^\s*\$S\.panel = \[string\]\$m\['panel'\]$/,
    /^\s*\$S\.screen = \[string\]\$m\['name'\]$/,
    /^\s*Show-Steps \(\[int\]\$m\['step'\]\)$/,
    /^\s*\$label = \[string\]\$row\['label'\]$/,
    /^\s*Set-Mark \$block \$label \(\[string\]\$row\['mark'\]\)$/,
    /^\s*\$S\.rows\[\[string\]\$row\['id'\]\] = @\{ block = \$block; label = \$label \}$/,
    /^\s*\$row = \$S\.rows\[\[string\]\$m\['id'\]\]$/,
    /^\s*if \(\$null -ne \$row\) \{ Set-Mark \$row\.block \$row\.label \(\[string\]\$m\['mark'\]\) \}$/,
    /^\s*if \(\[bool\]\$m\['details'\]\) \{ \$ui\.Details\.Visibility = \$visible \} else \{ \$ui\.Details\.Visibility = \$collapsed \}$/,
    /^\s*\$ui\.(?:NextButton|BackButton)\.IsEnabled = \[bool\]\$m\['(?:next|back)'\]$/,
    /^\s*if \(\$null -ne \$m\['(next|back)'\]\) \{ \$ui\.(?:Next|Back)Button\.Content = \[string\]\$m\['\1'\]; .* \}$/,
    /^\s*\$ui\.Body\.Text = \[string\]::Join\(\[Environment\]::NewLine \+ \[Environment\]::NewLine, \[string\[\]\]@\(\$m\['lines'\]\)\)$/,
    /^\s*\$ui\.DetailsText\.AppendText\(\[string\]\$m\['text'\] \+ \[Environment\]::NewLine\)$/,
    /^\s*(?:\$window\.Title|\$ui\.\w+\.(?:Text|Content|Header)) = \[string\]\$(?:m|w)\['\w+'\]$/,
    /^\s*\[Windows\.Automation\.AutomationProperties\]::SetName\(\$ui\.\w+, \[string\]\$w\['\w+'\]\)$/,
  ];
  for (const line of uses) {
    assert.ok(
      allowed.some(pattern => pattern.test(line)),
      line,
    );
  }
  // The words kept from the first message are shown the same way.
  const kept = rest.match(/[^\n]*\$S\.words\[[^\n]*/g) ?? [];
  for (const line of kept) {
    assert.match(
      line,
      /\[string\]\$S\.words\['\w+'\]|foreach \(\$label in \$S\.words\['steps'\]\)|\$labels = \$S\.words\['ruleLabels'\]|\[string\]\$S\.words\['markLabels'\]/,
    );
  }
});

test('the password is read as protected text only and leaves the window as a password frame only', () => {
  // The plain-text property of a password box is never read.
  assert.ok(!/\.Password\b(?!Changed)/.test(WINDOW_SCRIPT));
  assert.equal(WINDOW_SCRIPT.split('.SecurePassword').length, 2);
  // What is copied out is wiped: the unmanaged copy, the letters and the bytes.
  assert.ok(WINDOW_SCRIPT.includes('ZeroFreeGlobalAllocUnicode($ptr)'));
  assert.ok(WINDOW_SCRIPT.includes('[Array]::Clear($chars, 0, $chars.Length)'));
  assert.ok(WINDOW_SCRIPT.includes('[Array]::Clear($secret.bytes, 0, $secret.bytes.Length)'));
  assert.equal(WINDOW_SCRIPT.split('GCHandleType]::Pinned').length, 3);
  // Every secret that is read is cleared in a finally block.
  const reads = WINDOW_SCRIPT.match(/= Read-Secret /g) ?? [];
  const clears = WINDOW_SCRIPT.match(/Clear-Secret \$\w+/g) ?? [];
  assert.equal(reads.length, 4);
  assert.equal(clears.length, 4);
  // Password frames carry only those bytes, and no message frame is built from them.
  const frames = WINDOW_SCRIPT.match(/Send-Frame 2 [^\n]*/g) ?? [];
  assert.deepEqual(frames, [
    'Send-Frame 2 $secret.bytes $secret.len',
    'Send-Frame 2 $again.bytes $again.len } finally { Clear-Secret $again }',
  ]);
  assert.ok(!/Send-Message[^\n]*(secret|again|bytes)/.test(WINDOW_SCRIPT));
  // The window takes message frames only, and refuses one that is too long before reading it.
  assert.ok(WINDOW_SCRIPT.includes('if ($S.buf[0] -ne 1 -or $length -lt 0 -or $length -gt 65536)'));
});
