import type { ExecResult, SandboxExecParams } from '@truefoundry/trueforge-core/core';
import { connect } from 'node:net';
import { FakeSandboxProvider } from './fakeSandboxProvider';

/** The command a chat runs to have its skill fetch from one site: `fetch-notes <site>`. */
export const SKILL_FETCH_COMMAND = 'fetch-notes';

/** The folder the chat's commands run in. */
const WORKSPACE_DIR = '/workspace';

/**
 * A sandbox with no network of its own whose one real command is a skill's fetch script. The
 * script reaches its site the only way a skill can: through the skill network gateway, with the
 * grant the command was handed. Every other command does nothing and succeeds.
 */
export class SkillSiteSandbox extends FakeSandboxProvider {
  readonly network = 'none';
  /** What each fetch printed, in order. */
  readonly fetches: { site: string; output: string }[] = [];

  constructor(private readonly gatewaySocketPath: string) {
    super(new Map());
  }

  override async exec(params?: SandboxExecParams): Promise<ExecResult> {
    const site = params?.command.startsWith(`${SKILL_FETCH_COMMAND} `)
      ? params.command.slice(SKILL_FETCH_COMMAND.length + 1).trim()
      : undefined;
    if (site === undefined) {
      const result = params?.command.includes('git rev-parse --show-toplevel') === true ? WORKSPACE_DIR : '';
      return { success: true, response: { exitCode: 0, result } };
    }
    const output = await this.fetchThroughGateway({ site, token: params?.skillNetworkToken });
    this.fetches.push({ site, output });
    return { success: true, response: { exitCode: output.startsWith('200') ? 0 : 1, result: output } };
  }

  /** One CONNECT to the gateway, then one line to the site; returns the status and what came back. */
  private fetchThroughGateway({ site, token }: { site: string; token: string | undefined }): Promise<string> {
    if (token === undefined) {
      return Promise.resolve('This sandbox has no network.');
    }
    return new Promise((resolve, reject) => {
      const socket = connect(this.gatewaySocketPath);
      let received = '';
      let greeted = false;
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(
          `CONNECT ${site}:443 HTTP/1.1\r\nHost: ${site}:443\r\nX-Aman-Skill-Network-Token: ${token}\r\n\r\n`,
        );
      });
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
        if (!greeted && received.startsWith('HTTP/1.1 200') && received.includes('\r\n\r\n')) {
          greeted = true;
          received = '200 ';
          socket.write('today\n');
          return;
        }
        if (greeted && received.includes('\n')) {
          socket.end();
        }
      });
      socket.once('close', () => {
        resolve(received.replace(/^HTTP\/1\.1 /, '').trim());
      });
    });
  }
}
