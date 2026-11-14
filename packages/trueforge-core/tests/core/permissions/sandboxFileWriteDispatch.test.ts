/**
 * The dispatch-time containment re-check follows the file-write fact the host
 * stamps from the tool set's own declaration, not the tool's name.
 *
 * An invented tool whose registration declares file-writing gets the re-check.
 * The same call without the declaration passes through like any other silent call.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import {
  verifyPreDispatch,
  type DispatchCheckContext,
  type VerifiableCall,
} from '../../../src/core/permissions/dispatch';
import { SANDBOX_FILE_WRITE_TOOLS } from '../../../src/core/sandbox/Sandbox';

function makeCtx(workspaceCwd: string | null): DispatchCheckContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: 'r1',
    workspace_cwd: workspaceCwd,
    agent_intent: null,
    offline: false,
  };
}

function silentCall(input: { tool_name: string; path: string; sandbox_file_write: boolean }): VerifiableCall {
  return {
    tool_name: input.tool_name,
    tool_type: 'truefoundry-system',
    canonical_params: { path: input.path, content: 'x' },
    tier: 1,
    sandbox_file_write: input.sandbox_file_write,
    approval_token_id: null,
    approval_binding: null,
    shell_binding: null,
  };
}

describe('the dispatch re-check follows the declared file-write fact', () => {
  test('an invented tool that declares file-writing is refused when its target is outside the workspace', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'file-write-dispatch-')));
    try {
      const workspace = join(root, 'workspace');
      mkdirSync(workspace);
      const message = await verifyPreDispatch({
        call: silentCall({
          tool_name: 'invented_file_writer',
          path: join(root, 'outside.txt'),
          sandbox_file_write: true,
        }),
        ctx: makeCtx(workspace),
      });
      expect(message).toMatch(/outside the workspace at dispatch/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an invented tool that declares file-writing is refused when no workspace is set', async () => {
    const message = await verifyPreDispatch({
      call: silentCall({ tool_name: 'invented_file_writer', path: 'notes.txt', sandbox_file_write: true }),
      ctx: makeCtx(null),
    });
    expect(message).toMatch(/no workspace is set/i);
  });

  test('an invented tool inside the workspace passes the re-check', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'file-write-dispatch-')));
    try {
      const workspace = join(root, 'workspace');
      mkdirSync(workspace);
      const message = await verifyPreDispatch({
        call: silentCall({
          tool_name: 'invented_file_writer',
          path: join(workspace, 'notes.txt'),
          sandbox_file_write: true,
        }),
        ctx: makeCtx(workspace),
      });
      expect(message).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an invented tool that does not declare file-writing gets no re-check', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'file-write-dispatch-')));
    try {
      const workspace = join(root, 'workspace');
      mkdirSync(workspace);
      const message = await verifyPreDispatch({
        call: silentCall({
          tool_name: 'invented_file_writer',
          path: join(root, 'outside.txt'),
          sandbox_file_write: false,
        }),
        ctx: makeCtx(workspace),
      });
      expect(message).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("today's write_file keeps the re-check through the fact its registration produces", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'file-write-dispatch-')));
    try {
      const workspace = join(root, 'workspace');
      mkdirSync(workspace);
      const message = await verifyPreDispatch({
        call: silentCall({
          tool_name: 'write_file',
          path: join(root, 'outside.txt'),
          sandbox_file_write: SANDBOX_FILE_WRITE_TOOLS.has('write_file'),
        }),
        ctx: makeCtx(workspace),
      });
      expect(message).toMatch(/outside the workspace at dispatch/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
