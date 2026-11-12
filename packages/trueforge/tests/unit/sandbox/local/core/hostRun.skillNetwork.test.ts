import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { SANDBOX_ALLOWED_EGRESS_DOMAINS } from '@truefoundry/trueforge-core/core';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSupervisorSession } from '../../../../../src/sandbox/local/core/hostRun';

/**
 * The SRT path has no gateway: the per-command allowed domains are the wall. These tests watch
 * what runSupervisorSession hands the sandbox wrapper, with the wrapper replaced by a harmless
 * node call, following the cancellation tests' harness.
 */
describe('runSupervisorSession skill network domains', () => {
  let sandboxRootPath: string;
  let wrapSpy: jest.SpyInstance;
  let cleanupSpy: jest.SpyInstance;

  beforeEach(async () => {
    sandboxRootPath = await mkdtemp(join(tmpdir(), 'tfy-skillnet-srt-'));
    await mkdir(join(sandboxRootPath, '.tmp'));
    await mkdir(join(sandboxRootPath, '.home'));
    wrapSpy = jest.spyOn(SandboxManager, 'wrapWithSandboxArgv').mockResolvedValue({
      argv: [process.execPath, '-e', ''],
      env: {},
    });
    cleanupSpy = jest.spyOn(SandboxManager, 'cleanupAfterCommand').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    wrapSpy.mockRestore();
    cleanupSpy.mockRestore();
    await rm(sandboxRootPath, { recursive: true, force: true });
  });

  function wrappedDomains(): string[] {
    const calls = wrapSpy.mock.calls;
    const config = calls[calls.length - 1]?.[2] as { network: { allowedDomains: string[] } } | undefined;
    if (config === undefined) throw new Error('the wrapper was never called');
    return config.network.allowedDomains;
  }

  async function run(extraAllowedDomains?: readonly string[]): Promise<void> {
    await runSupervisorSession({
      sandboxRootPath,
      command: 'true',
      shell: '/bin/sh',
      platform: 'linux',
      signal: undefined,
      timeoutMs: 5_000,
      ...(extraAllowedDomains === undefined ? {} : { extraAllowedDomains }),
    });
  }

  it('adds the granted hosts to this command allowed domains, on top of the shared list', async () => {
    // The Google skill's hosts from the design: neither is in the shared egress list.
    await run(['gmail.googleapis.com', 'oauth2.googleapis.com']);
    const domains = wrappedDomains();
    for (const shared of SANDBOX_ALLOWED_EGRESS_DOMAINS) {
      expect(domains).toContain(shared);
    }
    expect(domains).toContain('gmail.googleapis.com');
    expect(domains).toContain('oauth2.googleapis.com');
    expect(domains).toHaveLength(SANDBOX_ALLOWED_EGRESS_DOMAINS.length + 2);
  });

  it('without a grant the allowed domains are exactly the shared list, as today', async () => {
    await run(undefined);
    expect(wrappedDomains()).toEqual([...SANDBOX_ALLOWED_EGRESS_DOMAINS]);
  });

  it('never duplicates a domain, and the shared list itself is not widened for the next command', async () => {
    const shared = SANDBOX_ALLOWED_EGRESS_DOMAINS[0];
    if (shared === undefined) throw new Error('the shared egress list is empty');
    await run(['gmail.googleapis.com', 'gmail.googleapis.com', shared]);
    const domains = wrappedDomains();
    expect(domains.filter(domain => domain === 'gmail.googleapis.com')).toHaveLength(1);
    expect(domains.filter(domain => domain === shared)).toHaveLength(1);
    await run(undefined);
    expect(wrappedDomains()).toEqual([...SANDBOX_ALLOWED_EGRESS_DOMAINS]);
    expect(SANDBOX_ALLOWED_EGRESS_DOMAINS).not.toContain('gmail.googleapis.com');
  });
});
