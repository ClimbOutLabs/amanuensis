import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasAnyHiddenCharacter } from '../../../src/core/email/gmail/mimeText';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { seedShellAllowlist } from '../../../src/core/permissions/shellAllowlist';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

const BIDI_CONTROLS: Array<[string, string]> = [
  ['right-to-left override', String.fromCodePoint(0x202e)],
  ['left-to-right isolate', String.fromCodePoint(0x2066)],
  ['right-to-left isolate', String.fromCodePoint(0x2067)],
  ['first strong isolate', String.fromCodePoint(0x2068)],
  ['pop directional isolate', String.fromCodePoint(0x2069)],
  ['right-to-left mark', String.fromCodePoint(0x200f)],
];

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function makeCtx(input: { workspace_cwd: string | null; services?: SentinelServices }): ClassifyContext {
  return {
    services: input.services ?? defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: 'r1',
    workspace_cwd: input.workspace_cwd,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

/** Services whose allowlist names real files, so `ls`, `cat` and `git` match the way they do in production. */
function allowlistedServices(): SentinelServices {
  const bin = tempDir('card-label-bin-');
  for (const name of ['ls', 'cat', 'pwd', 'git', 'node', 'python3']) {
    writeFileSync(join(bin, name), '#!/bin/sh\n');
  }
  return { ...defaultSentinelServices({ pinned_path: bin }), shell_allowlist: seedShellAllowlist(bin) };
}

function action(
  tool_name: string,
  canonical_params: Record<string, unknown>,
  overrides: Partial<SentinelAction> = {},
): SentinelAction {
  return { tool_name, canonical_params, tool_type: 'truefoundry-system', mcp_hints: {}, ...overrides };
}

function mapsAction(tool_name: string, canonical_params: Record<string, unknown>): SentinelAction {
  return action(tool_name, canonical_params, {
    mcp_server_name: 'maps',
    mcp_first_party: true,
    maps_hosts: {
      geocoder: 'https://nominatim.openstreetmap.org',
      router: 'https://router.project-osrm.org',
      walking: 'https://routing.openstreetmap.de/routed-foot',
      cycling: 'https://routing.openstreetmap.de/routed-bike',
      transit: 'https://api.transitous.org/api/v6',
      tile: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    },
  });
}

function hiddenCodePointsIn(text: string): string[] {
  return Array.from(text).filter(char => hasAnyHiddenCharacter(char));
}

interface LabelCase {
  /** The card sentence under test. */
  label: string;
  build: (control: string) => { call: SentinelAction; ctx: ClassifyContext };
  /** The model-supplied text as it must appear once the control is a code. */
  shown: (code: string) => string;
}

const LABEL_CASES: LabelCase[] = [
  {
    label: 'maps place',
    build: control => ({
      call: mapsAction('render_map', { place_name: `Paris${control}` }),
      ctx: makeCtx({ workspace_cwd: null }),
    }),
    shown: code => `"Paris${code}"`,
  },
  {
    label: 'maps route from and to',
    build: control => ({
      call: mapsAction('render_route', { from_place: `Madrid${control}`, to_place: `Rome${control}` }),
      ctx: makeCtx({ workspace_cwd: null }),
    }),
    shown: code => `"Madrid${code}" and "Rome${code}"`,
  },
  {
    label: 'maps point of interest',
    build: control => ({
      call: mapsAction('render_map', { place_name: 'Paris', poi: `cafe${control}` }),
      ctx: makeCtx({ workspace_cwd: null }),
    }),
    shown: code => `"cafe${code}"`,
  },
  {
    label: 'command with custom environment variables',
    build: control => ({
      call: action('exec', { command: `echo hi${control}`, env: { FOO: 'bar' } }),
      ctx: makeCtx({ workspace_cwd: '/tmp' }),
    }),
    shown: code => `echo hi${code}`,
  },
  {
    label: 'executed file the server cannot resolve',
    build: control => {
      const workspace = tempDir('card-label-ws-');
      return {
        call: action('exec', { command: `sh missing${control}.sh`, cwd: workspace }),
        ctx: makeCtx({ workspace_cwd: workspace }),
      };
    },
    shown: code => `missing${code}.sh`,
  },
  {
    label: 'script the agent wrote earlier',
    build: control => {
      const workspace = tempDir('card-label-ws-');
      const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
      const file = join(workspace, `tool${control}.sh`);
      writeFileSync(file, 'echo hi');
      services.tracked_store.track({
        scope: { tenant_id: 't1', created_by: 'u1', repository_id: 'r1', workspace_cwd: workspace },
        file_identity: realpathSync(file),
      });
      return {
        call: action('exec', { command: `sh tool${control}.sh`, cwd: workspace }),
        ctx: makeCtx({ workspace_cwd: workspace, services }),
      };
    },
    shown: code => `tool${code}.sh`,
  },
  {
    label: 'command with no workspace set',
    build: control => ({
      call: action('exec', { command: `ls ${control}x` }),
      ctx: makeCtx({ workspace_cwd: null, services: allowlistedServices() }),
    }),
    shown: code => `ls ${code}x`,
  },
  {
    label: 'command from outside the workspace',
    build: control => ({
      call: action('exec', { command: `ls ${control}x`, cwd: '/' }),
      ctx: makeCtx({ workspace_cwd: tempDir('card-label-ws-'), services: allowlistedServices() }),
    }),
    shown: code => `ls ${code}x`,
  },
  {
    label: 'file outside the workspace',
    build: control => {
      const workspace = tempDir('card-label-ws-');
      const outside = tempDir('card-label-outside-');
      writeFileSync(join(outside, 'secret.txt'), 'x');
      // A link that resolves outside is the one way an allowlisted operand leaves the workspace.
      symlinkSync(join(outside, 'secret.txt'), join(workspace, `link${control}.txt`));
      return {
        call: action('exec', { command: `cat link${control}.txt`, cwd: workspace }),
        ctx: makeCtx({ workspace_cwd: workspace, services: allowlistedServices() }),
      };
    },
    shown: code => `cat link${code}.txt`,
  },
  {
    label: 'arguments the safe list does not allow',
    build: control => {
      const workspace = tempDir('card-label-ws-');
      return {
        call: action('exec', { command: `git${control} push`, cwd: workspace }),
        ctx: makeCtx({ workspace_cwd: workspace }),
      };
    },
    shown: code => `git${code}`,
  },
  {
    label: 'write outside the workspace',
    build: control => ({
      call: action('write_file', { path: `/etc/note${control}.txt`, content: 'x' }),
      ctx: makeCtx({ workspace_cwd: tempDir('card-label-ws-') }),
    }),
    shown: code => `note${code}.txt`,
  },
  {
    label: 'write to a Git control file',
    build: control => {
      const workspace = tempDir('card-label-ws-');
      mkdirSync(join(workspace, '.git'));
      return {
        call: action('write_file', { path: join(workspace, '.git', `config${control}`), content: 'x' }),
        ctx: makeCtx({ workspace_cwd: workspace }),
      };
    },
    shown: code => `config${code}`,
  },
  {
    label: 'change inside the workspace',
    build: control => {
      const workspace = tempDir('card-label-ws-');
      return {
        call: action('write_file', { path: join(workspace, `notes${control}.md`), content: 'x' }),
        ctx: makeCtx({ workspace_cwd: workspace }),
      };
    },
    shown: code => `notes${code}.md`,
  },
  {
    label: 'tool name on a flagged connector call',
    build: control => ({
      call: action(
        `lookup${control}_records`,
        { text: 'hi' },
        {
          tool_type: 'mcp',
          mcp_server_name: 'crm',
          mcp_server_host: 'mcp.crm.example',
          mcp_hints: { destructive_hint: true },
        },
      ),
      ctx: makeCtx({ workspace_cwd: null }),
    }),
    shown: code => `lookup${code}_records`,
  },
  {
    label: 'web search query and server name',
    build: control => ({
      call: action(
        'web_lookup',
        { query: `weather${control}` },
        {
          tool_type: 'mcp',
          mcp_server_name: `search${control}`,
          mcp_search_provider: true,
          mcp_hints: { read_only_hint: true },
        },
      ),
      ctx: makeCtx({
        workspace_cwd: null,
        services: {
          ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
          searchWithoutAsking: async () => false,
        },
      }),
    }),
    shown: code => `through search${code} for: weather${code}`,
  },
];

describe.each(BIDI_CONTROLS)('%s in model-supplied card text', (_name, control) => {
  const code = `\\u{${(control.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}}`;

  it.each(LABEL_CASES)('shows the control as a code in the $label sentence', async ({ build, shown }) => {
    const { call, ctx } = build(control);
    const decision = await classifyTier(call, ctx);
    const what = decision.card?.plain_what ?? '';
    expect(hiddenCodePointsIn(what)).toEqual([]);
    expect(what).toContain(shown(code));
  });
});
