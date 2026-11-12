import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import {
  parseReadOnlyList,
  parseSimpleCommand,
  seedShellAllowlist,
  type ShellAllowlistConfig,
} from '../../../src/core/permissions/shellAllowlist';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

/**
 * A read command that would run something else: a wrapper that runs whatever it is handed, a
 * substitution, an environment prefix, or a git flag that writes or configures. None of these may
 * ever count as a free read, at the parser, at the read-only list, or at the classifier.
 */

const PINNED = '/usr/bin:/bin';

describe('the strict parser refuses wrapper commands outright', () => {
  test.each([
    'find . -type f',
    'find . -name "*.md" -print',
    'find . -exec cat {} +',
    'find . -delete',
    'timeout 5 ls',
    'sudo ls',
    'xargs cat',
    'env ls',
    'nice -n 10 ls',
    'nice FOO=bar ls',
  ])('%s does not parse as a simple command', command => {
    expect(parseSimpleCommand(command)).toBeUndefined();
  });
});

describe('a read-only list with a wrapper step is not a read-only list', () => {
  const config = seedShellAllowlist(PINNED);
  const parse = (command: string) => parseReadOnlyList({ command, config });

  test.each(['ls && find . -type f', 'grep -rn TODO src | xargs cat', 'ls && timeout 5 cat notes.txt'])(
    '%s is refused as a list',
    command => {
      expect(parse(command)).toBeUndefined();
    },
  );

  test('a list of plain reads still parses', () => {
    expect(parse('grep -rn TODO src | head -20')).toBeDefined();
    expect(parse('ls; pwd')).toBeDefined();
  });
});

/** Environment-independent allowlist: a temp dir with one fake `mycmd` executable. */
function servicesWithTempAllowlist(): { services: SentinelServices; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-bin-'));
  writeFileSync(join(dir, 'mycmd'), '#!/bin/sh\n');
  const shell_allowlist: ShellAllowlistConfig = {
    pinned_path: dir,
    commands: {
      mycmd: { args: ['-l'], operands: 'workspace_relative', offline_ok: true, script: null, subcommands: null },
    },
  };
  const services = defaultSentinelServices({ pinned_path: dir });
  services.shell_allowlist = shell_allowlist;
  return { services, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeCtx(services: SentinelServices): ClassifyContext {
  return {
    services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: 'r1',
    workspace_cwd: tmpdir(),
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

function action(tool_name: string, canonical_params: Record<string, unknown>): SentinelAction {
  return { tool_name, canonical_params, tool_type: 'truefoundry-system', mcp_hints: {} };
}

describe('the classifier never lets a wrapped command run as a free read', () => {
  test('the plain allowlisted command still runs silently, as the control', async () => {
    const { services, cleanup } = servicesWithTempAllowlist();
    try {
      const decision = await classifyTier(action('exec', { command: 'mycmd -l' }), makeCtx(services));
      expect(decision.tier).toBe(1);
      expect(decision.reason).toBe('shell_allowlist');
    } finally {
      cleanup();
    }
  });

  test.each([
    'find . -type f',
    'find . -exec cat {} +',
    'ls | xargs cat',
    'cat names.txt | sh',
    'cat $(cat names.txt)',
    'cat `cat names.txt`',
    'MAYA=1 ls',
    'ls > out.txt',
    'cat notes.txt >> out.txt',
    'ls && rm -f out.txt',
    'ls; rm -f out.txt',
    'git -c core.pager=cat log --oneline',
    'git log --output=out.txt',
    'git diff --output=out.txt',
  ])('%s is held for a card', async command => {
    const decision = await classifyTier(
      action('exec', { command }),
      makeCtx(defaultSentinelServices({ pinned_path: PINNED })),
    );
    expect(decision.tier).toBe(3);
    expect(decision.tier).not.toBe(1);
  });
});
