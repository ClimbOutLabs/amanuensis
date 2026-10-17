import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { commandWithWorkspaceLock } from '../../../src/core/sandbox/provider/Provider';
import {
  buildStructuredEditObservationCommand,
  parseStructuredEditObservation,
} from '../../../src/core/sandbox/structuredEditPrecondition';

const execFileAsync = promisify(execFile);

// These tests spawn a real shell and depend on the Linux `flock` utility, which
// Git Bash on Windows does not ship. Skip on win32 rather than fail, matching
// provider/workspaceLease.contract.test.ts.
const unixOnly = process.platform === 'win32' ? it.skip : it;

describe('structured-edit observation in non-git workspaces', () => {
  unixOnly('observes real file bytes through the lock wrapper and verifies the sha256', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'trueforge-observe-'));
    const content = 'export default function App() {\n  return <div>hello</div>;\n}\n';
    await mkdir(join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(join(workspaceRoot, 'src', 'App.tsx'), content);

    // The exact pre-approval path: the observation command wrapped in the real
    // shell lock, run against a workspace with no .git directory.
    const wrapped = commandWithWorkspaceLock({
      sandboxId: 'test',
      command: buildStructuredEditObservationCommand({
        kind: 'replace_text',
        workspaceRoot,
        paths: ['src/App.tsx'],
      }),
      workspaceLock: { workspaceRoot },
    });
    const { stdout } = await execFileAsync('sh', ['-c', wrapped.command]);

    const precondition = parseStructuredEditObservation(stdout.trim(), ['src/App.tsx']);
    expect(precondition.targets).toHaveLength(1);
    expect(precondition.targets[0]?.state).toBe('present');
    expect(precondition.targets[0]?.byte_length).toBe(Buffer.byteLength(content));
    expect(precondition.targets[0]?.sha256).toBe(createHash('sha256').update(content, 'utf8').digest('hex'));
  });
});
