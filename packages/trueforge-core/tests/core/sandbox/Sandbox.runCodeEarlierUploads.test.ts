import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import { stageAttachment } from '../../../src/core/runtime/attachmentStaging';
import type { RunCodeResult } from '../../../src/core/sandbox/driver/RunCodeSchemas';
import type {
  RunCodeBackend,
  RunCodeCallOptions,
  TurnAttachment,
} from '../../../src/core/sandbox/driver/RunCodeService';
import type { SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { runCodeResultText, Sandbox, SANDBOX_RUN_CODE_TOOL_NAME } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';
import { realCommandExec } from './realCommandExec';

const OK_RESULT: RunCodeResult = {
  status: 'ok',
  stdout: '',
  stderr: '',
  stdout_truncated: false,
  stderr_truncated: false,
  exit_code: 0,
  files_out: [],
  harvest_warnings: [],
};

describe('run_code reads uploads from earlier turns', () => {
  let root: string;
  let uploads: string;
  let execCommands: string[];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'run-code-uploads-')));
    uploads = join(root, 'uploads');
    mkdirSync(uploads);
    execCommands = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A sandbox whose workspace is a real folder, so its files outlive the Sandbox object of one turn. */
  function provider(): SandboxProvider {
    return {
      type: 'test',
      buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
      getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
      createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
      acknowledgeWorkspaceTermination: () => Promise.resolve(),
      executeVerifiedWorkspaceCommit: () =>
        Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'not used by this fixture' } }),
      getAdditionalInstructions: () => undefined,
      getWorkspaceDir: () => root,
      getToolResultDumpDir: () => join(root, 'tool-results'),
      getGitCredentialsPath: () => join(root, '.git-credentials'),
      getFileUploadsDir: () => uploads,
      getSkillsDir: () => join(root, 'skills'),
      getSkillDownloaderPath: () => join(root, 'git_downloader.py'),
      downloadFile: ({ path }) => Promise.resolve(readFileSync(path)),
      uploadFile: ({ remotePath, content }) => {
        mkdirSync(dirname(remotePath), { recursive: true });
        writeFileSync(remotePath, content);
        return Promise.resolve();
      },
      createCodeModeTransport: jest.fn(),
      exec: realCommandExec((params: SandboxExecParams) => {
        execCommands.push(params.command);
        const run = spawnSync('/bin/sh', ['-c', params.command], { encoding: 'utf8' });
        return Promise.resolve({ success: true, response: { exitCode: run.status ?? 1, result: run.stdout } });
      }),
    };
  }

  /** One turn's Sandbox object. `existingSandboxId` is how a later turn finds the chat's sandbox again. */
  function turn(existingSandboxId: string | undefined): { sandbox: Sandbox; ingressOf: () => TurnAttachment[] } {
    const runCode = jest.fn<Promise<RunCodeResult>, [unknown, (RunCodeCallOptions | undefined)?]>(() =>
      Promise.resolve(OK_RESULT),
    );
    const service: RunCodeBackend = { runCode, scrubDispatchErrorText: text => text, packageGatewayCapable: false };
    const sandbox = new Sandbox({
      provider: provider(),
      existingSandboxId,
      workspaceVerificationCoordinator: undefined,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
      runCodeService: service,
    });
    return { sandbox, ingressOf: () => runCode.mock.calls.at(-1)?.[1]?.attachments ?? [] };
  }

  async function run(sandbox: Sandbox, code: string): Promise<void> {
    const response = await sandbox.callTool(
      { name: SANDBOX_RUN_CODE_TOOL_NAME, arguments: { language: 'python', code } },
      { status: 'allow', scope: 'once' },
    );
    if (!isCallToolResponseResult(response)) {
      throw new Error(`expected a tool result: ${JSON.stringify(response)}`);
    }
  }

  /** Stages files in a first turn and returns their staged names and the chat's sandbox id. */
  async function firstTurnWith(
    files: { filename: string; bytes: Buffer }[],
  ): Promise<{ sandboxId: string; stagedNames: string[] }> {
    const first = turn(undefined);
    const stagedNames: string[] = [];
    let sandboxId: string | undefined;
    for (const [index, file] of files.entries()) {
      const staged = await stageAttachment({ sandbox: first.sandbox, ...file, mime: 'image/png', ordinal: index + 1 });
      stagedNames.push(staged.stagedName);
      sandboxId = staged.sandboxCreated?.sandbox_id ?? sandboxId;
    }
    if (sandboxId === undefined) {
      throw new Error('staging did not create a sandbox');
    }
    return { sandboxId, stagedNames };
  }

  const IMAGE = Buffer.from('not really a png, but bytes all the same');
  const OTHER = Buffer.from('a second file');

  it('gives a later turn the image an earlier turn uploaded, at the /ingress path the model was told', async () => {
    const { sandboxId, stagedNames } = await firstTurnWith([{ filename: 'image.png', bytes: IMAGE }]);
    const later = turn(sandboxId);

    await run(later.sandbox, `from PIL import Image\nImage.open('/ingress/${stagedNames[0] ?? ''}')`);

    expect(later.ingressOf()).toEqual([{ name: stagedNames[0], bytes: IMAGE }]);
  });

  it('brings back only the files the code names when it names some', async () => {
    const { sandboxId, stagedNames } = await firstTurnWith([
      { filename: 'image.png', bytes: IMAGE },
      { filename: 'other.png', bytes: OTHER },
    ]);
    const later = turn(sandboxId);

    await run(later.sandbox, `open('/ingress/${stagedNames[1] ?? ''}', 'rb')`);

    expect(later.ingressOf()).toEqual([{ name: stagedNames[1], bytes: OTHER }]);
  });

  it('brings back every earlier upload when the code looks in /ingress without naming a file', async () => {
    const { sandboxId, stagedNames } = await firstTurnWith([
      { filename: 'image.png', bytes: IMAGE },
      { filename: 'other.png', bytes: OTHER },
    ]);
    const later = turn(sandboxId);

    await run(later.sandbox, "import os\nprint(os.listdir('/ingress'))");

    expect(
      later
        .ingressOf()
        .map(file => file.name)
        .sort(),
    ).toEqual([...stagedNames].sort());
  });

  it('leaves out a file whose bytes were changed after it was uploaded', async () => {
    const { sandboxId, stagedNames } = await firstTurnWith([{ filename: 'image.png', bytes: IMAGE }]);
    writeFileSync(join(uploads, stagedNames[0] ?? ''), 'something else');
    const later = turn(sandboxId);

    await run(later.sandbox, `open('/ingress/${stagedNames[0] ?? ''}', 'rb')`);

    expect(later.ingressOf()).toEqual([]);
  });

  it('ignores files in the uploads folder that staging did not name', async () => {
    const { sandboxId } = await firstTurnWith([{ filename: 'image.png', bytes: IMAGE }]);
    writeFileSync(join(uploads, 'notes.txt'), 'made by a command');
    const later = turn(sandboxId);

    await run(later.sandbox, "import os\nprint(os.listdir('/ingress'))");

    expect(later.ingressOf().map(file => file.name)).not.toContain('notes.txt');
    expect(later.ingressOf()).toHaveLength(1);
  });

  it('does not look in the workspace for code that never mentions /ingress', async () => {
    const { sandboxId } = await firstTurnWith([{ filename: 'image.png', bytes: IMAGE }]);
    const later = turn(sandboxId);
    execCommands = [];

    await run(later.sandbox, 'print(1 + 1)');

    expect(later.ingressOf()).toEqual([]);
    expect(execCommands.filter(command => command.startsWith('ls '))).toEqual([]);
  });

  it('lists the workspace once per turn and keeps what it read for the next run', async () => {
    const { sandboxId, stagedNames } = await firstTurnWith([{ filename: 'image.png', bytes: IMAGE }]);
    const later = turn(sandboxId);
    execCommands = [];
    const code = `open('/ingress/${stagedNames[0] ?? ''}', 'rb')`;

    await run(later.sandbox, code);
    await run(later.sandbox, code);

    expect(later.ingressOf()).toEqual([{ name: stagedNames[0], bytes: IMAGE }]);
    expect(execCommands.filter(command => command.startsWith('ls '))).toHaveLength(1);
  });
});

describe('what the model reads for a run', () => {
  it('says ok for a program that ended cleanly', () => {
    expect(JSON.parse(runCodeResultText(OK_RESULT))).toMatchObject({ status: 'ok', exit_code: 0 });
  });

  it('says exited, not ok, for a program that ended with an error', () => {
    const text = runCodeResultText({ ...OK_RESULT, exit_code: 1, stderr: 'FileNotFoundError' });
    expect(JSON.parse(text)).toMatchObject({ status: 'exited', exit_code: 1, stderr: 'FileNotFoundError' });
  });

  it('keeps failed for a run the sandbox could not carry out', () => {
    const text = runCodeResultText({ ...OK_RESULT, status: 'failed', error_code: 'timeout', error: 'too slow' });
    expect(JSON.parse(text)).toMatchObject({ status: 'failed', error_code: 'timeout' });
  });
});
