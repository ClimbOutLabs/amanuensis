import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

/**
 * A model often searches a saved tool result and trims the output, as in
 * `grep -oiE "..." /workspace/.aman/tool-results/x.txt | head -60`. Reads piped into reads inside the workspace run
 * without a card however their flags are spelled; a write, a redirect or a path outside the workspace still asks.
 */

const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });

function ctx(): ClassifyContext {
  return {
    services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: '/workspace',
    agent_intent: null,
    web_search: createWebSearchTurnState(),
    path_resolution: 'remote',
  };
}

function exec(command: string): SentinelAction {
  return { tool_name: 'exec', canonical_params: { command }, tool_type: 'truefoundry-system', mcp_hints: {} };
}

async function tierOf(command: string): Promise<number> {
  return (await classifyTier(exec(command), ctx())).tier;
}

const SAVED = '/workspace/.aman/tool-results/web_extract_1.txt';

describe('reads piped into reads inside the workspace', () => {
  test.each([
    `grep -oiE "[^.]*(\\$[0-9,]+|EUR [0-9]+|ferry|train)[^.]*" ${SAVED} | head -60`,
    `grep -ci "ferry" ${SAVED}`,
    `grep -o -i "price" ${SAVED} | sort | uniq -c | sort -rn | head -15`,
    `cat ${SAVED} | wc -l`,
    `tail -n 40 ${SAVED} | grep -n "total"`,
    'ls -lah /workspace/.aman/tool-results | tail -5',
  ])('runs without a card: %s', async command => {
    expect(await tierOf(command)).toBe(1);
  });

  test.each([
    `grep -oiE "ferry" ${SAVED} > /workspace/out.txt`,
    `grep -oiE "ferry" ${SAVED} | head -60 >> /workspace/out.txt`,
    `grep -oiE "$(cat /workspace/p.txt)" ${SAVED}`,
    `grep -oiE "ferry" ${SAVED} | sort -o /workspace/out.txt`,
    `grep -oiE "ferry" ${SAVED} | tee /workspace/out.txt`,
    `grep -oiE "ferry" ${SAVED} | xargs rm`,
    `grep -oiE "ferry" ${SAVED} | sh`,
    `grep -oiE "ferry" ${SAVED} && rm ${SAVED}`,
    `grep -oiE "ferry" /etc/passwd | head -60`,
    `grep -oiE "ferry" ${SAVED} | head -60 /etc/passwd`,
    `tail -f ${SAVED} | head -5`,
    `grep -oiE "ferry" ${SAVED} | uniq -c /workspace/out.txt`,
  ])('still asks: %s', async command => {
    expect(await tierOf(command)).toBe(3);
  });
});
