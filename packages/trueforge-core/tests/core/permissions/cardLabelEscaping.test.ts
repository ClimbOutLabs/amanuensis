import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { isHiddenCodePoint } from '../../../src/core/permissions/hiddenCharacters';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

const BIDI_CONTROLS: Array<[string, string]> = [
  ['right-to-left override', '‮'],
  ['left-to-right isolate', '⁦'],
  ['right-to-left isolate', '⁧'],
  ['first strong isolate', '⁨'],
  ['pop directional isolate', '⁩'],
  ['right-to-left mark', '‏'],
];

function makeCtx(workspace_cwd: string | null = null): ClassifyContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: 'r1',
    workspace_cwd,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
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
      tile: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    },
  });
}

function hiddenCodePointsIn(text: string): string[] {
  return Array.from(text).filter(char => isHiddenCodePoint(char.codePointAt(0) ?? 0));
}

describe.each(BIDI_CONTROLS)('%s in model-supplied card text', (_name, control) => {
  const code = `\\u{${(control.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}}`;

  it('shows the control as a code in a maps place name', async () => {
    const decision = await classifyTier(mapsAction('render_map', { place_name: `Paris${control}` }), makeCtx());
    const what = decision.card?.plain_what ?? '';
    expect(hiddenCodePointsIn(what)).toEqual([]);
    expect(what).toContain(`"Paris${code}"`);
  });

  it('shows the control as a code in every maps route and poi label', async () => {
    const route = await classifyTier(
      mapsAction('render_route', { from_place: `A${control}`, to_place: `B${control}` }),
      makeCtx(),
    );
    const poi = await classifyTier(mapsAction('render_map', { place_name: 'Paris', poi: `cafe${control}` }), makeCtx());
    for (const what of [route.card?.plain_what ?? '', poi.card?.plain_what ?? '']) {
      expect(hiddenCodePointsIn(what)).toEqual([]);
      expect(what).toContain(code);
    }
  });

  it('shows the control as a code in the command on an env override card', async () => {
    const decision = await classifyTier(
      action('exec', { command: `echo hi${control}`, env: { FOO: 'bar' } }),
      makeCtx('/tmp'),
    );
    const what = decision.card?.plain_what ?? '';
    expect(hiddenCodePointsIn(what)).toEqual([]);
    expect(what).toContain(`echo hi${code}`);
  });

  it('shows the control as a code in the target of a write outside the workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'card-label-'));
    const decision = await classifyTier(
      action('write_file', { path: `/etc/note${control}.txt`, content: 'x' }),
      makeCtx(workspace),
    );
    const what = decision.card?.plain_what ?? '';
    expect(hiddenCodePointsIn(what)).toEqual([]);
    expect(what).toContain(`note${code}.txt`);
  });

  it('shows the control as a code in the tool name on a flagged connector call', async () => {
    const decision = await classifyTier(
      action(
        `lookup${control}_records`,
        { text: 'hi' },
        {
          tool_type: 'mcp',
          mcp_server_name: 'crm',
          mcp_server_host: 'mcp.crm.example',
          mcp_hints: { destructive_hint: true },
        },
      ),
      makeCtx(),
    );
    const what = decision.card?.plain_what ?? '';
    expect(what).toContain('flagged as destructive');
    expect(hiddenCodePointsIn(what)).toEqual([]);
    expect(what).toContain(`lookup${code}_records`);
  });
});
