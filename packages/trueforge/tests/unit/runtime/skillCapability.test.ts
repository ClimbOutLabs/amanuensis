import {
  createSentinelHostContext,
  defaultSentinelServices,
  type SentinelServices,
} from '@truefoundry/trueforge-core/core';
import type { ApprovalDecision } from '@truefoundry/trueforge-core/core/events/schema';
import { InstructionBuilder } from '@truefoundry/trueforge-core/core/InstructionBuilder';
import type { InternalEnrichedAssistantMessage } from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { allowsChatApproval } from '@truefoundry/trueforge-core/core/mcp/approvalGrant';
import { createToolCallMemoState, executeToolCalls } from '@truefoundry/trueforge-core/core/mcp/executeToolCalls';
import { isCallToolResponseResult } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { Response as UndiciResponse } from 'undici';

import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import {
  skillCapability,
  SkillToolSet,
  storedSkillName,
  type SkillTurnContext,
} from '../../../src/runtime/skillCapability';
import type { SkillLookupDeps } from '../../../src/runtime/skillSource';
import { parseGitSkill } from '../../../src/schemas/skill';
import type { CatalogSkill } from '../../../src/schemas/skillCatalog';

const TENANT = 'default';
const COMMIT = 'a'.repeat(40);
const LATER_COMMIT = 'b'.repeat(40);
const STARTER_COMMIT = 'c'.repeat(40);
const SKILL_FILE =
  '---\nname: Release Notes\ndescription: Writes release notes from merged changes.\n---\n\n# Steps\n\nRead the log.\n';
const RELEASE_NOTES = { url: 'https://github.com/acme/skills/tree/main/skills/release-notes' };
const SKILL_PATH = `/repos/acme/skills/contents/skills/release-notes/SKILL.md`;
const FETCH_SCRIPT = 'import requests\n\nrequests.get("https://api.release-feed.info/v1/merged")\n';

const STARTER: CatalogSkill = {
  type: 'git',
  name: 'algorithmic-art',
  url: 'https://github.com/anthropics/skills',
  path: 'skills/algorithmic-art',
  ref: STARTER_COMMIT,
  description: 'Creating algorithmic art.',
  network_hosts: ['api.example.com'],
};

/** A GitHub stand-in whose main branch can move and whose file can change with it. */
function github() {
  const state = {
    head: COMMIT,
    files: new Map([[COMMIT, SKILL_FILE]]),
    scripts: new Map([[COMMIT, FETCH_SCRIPT]]),
    asked: 0,
    readFailure: false,
  };
  const readFiles: SkillTurnContext['readFiles'] = source => {
    const script = state.scripts.get(source.ref);
    const skillFile = state.files.get(source.ref);
    if (state.readFailure || skillFile === undefined) {
      return Promise.reject(new Error('could not fetch'));
    }
    const encode = (text: string) => new TextEncoder().encode(text);
    return Promise.resolve({
      objectId: source.ref,
      files: [
        { path: 'SKILL.md', bytes: encode(skillFile) },
        ...(script === undefined ? [] : [{ path: 'scripts/fetch.py', bytes: encode(script) }]),
      ],
    });
  };
  const lookup: SkillLookupDeps = {
    fetchImpl: url => {
      state.asked += 1;
      const path = String(url).replace('https://api.github.com', '');
      if (path === '/repos/acme/skills/commits/main') {
        return Promise.resolve(new UndiciResponse(JSON.stringify({ sha: state.head }), { status: 200 }));
      }
      const [file, ref] = path.split('?ref=');
      const body = file === SKILL_PATH && ref !== undefined ? state.files.get(ref) : undefined;
      return Promise.resolve(
        body === undefined ? new UndiciResponse('{}', { status: 404 }) : new UndiciResponse(body, { status: 200 }),
      );
    },
    resolveAddresses: () => Promise.resolve(['140.82.112.6']),
  };
  return { state, lookup, readFiles };
}

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const store = new SqliteSkillStore(db);
  const hub = github();
  const services: SentinelServices = { ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }) };
  const sentinel = createSentinelHostContext({
    services,
    tenant_id: TENANT,
    created_by: 'owner-1',
    conversation_id: 'chat-1',
  });
  const options = {
    tracing: NOOP_AGENT_TRACING,
    store,
    tenant_id: TENANT,
    catalog: [STARTER],
    sandboxReady: true,
    lookup: hub.lookup,
    readFiles: hub.readFiles,
    sentinel,
  };
  const tools = new SkillToolSet(options);
  const saved = () => store.listSkills({ tenant_id: TENANT, names: undefined });
  return { tools, options, sentinel, store, hub, saved };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Classifies a call as the chat would, then dispatches it with the user's answer (none for a call that never asks). */
async function dispatch(input: {
  built: Setup;
  args: Record<string, unknown>;
  decision?: ApprovalDecision | undefined;
  /** Runs between the card and the answer, to change what the card showed. */
  beforeAnswer?: (() => void) | undefined;
}) {
  const { tools, sentinel } = input.built;
  const name = 'install_skill';
  const info = await tools.toolCallInfo({ name, arguments: input.args });
  input.beforeAnswer?.();
  const message: InternalEnrichedAssistantMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(input.args) }, tool_info: info },
    ],
  };
  const result = await executeToolCalls({
    assistantMessage: message,
    toolMapping: new Map([[name, { toolSet: tools, originalToolName: name }]]),
    threadId: 'main',
    approvalDecisions: new Map(input.decision === undefined ? [] : [['call-1', input.decision]]),
    memoState: createToolCallMemoState(),
    sentinel: {
      services: sentinel.services,
      web_search: sentinel.web_search,
      identity: {
        tenant_id: sentinel.tenant_id,
        created_by: sentinel.created_by,
        conversation_id: sentinel.conversation_id,
        repository_id: null,
        workspace_cwd: null,
        agent_intent: null,
      },
    },
  });
  return { info, result };
}

function resultText(result: Awaited<ReturnType<typeof dispatch>>['result']): string {
  const content = result.toolCallResults[0]?.message.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

describe('install_skill', () => {
  it('asks every time: its card never offers a lasting answer', async () => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({ name: 'install_skill', arguments: RELEASE_NOTES });
    expect(info).toMatchObject({ tier: 3, tier_reason: 'skill_install', is_approval_required: true });
    expect(allowsChatApproval(info)).toBe(false);
  });

  it('shows what the host itself read at one exact commit, with the websites it found, then saves exactly that on approval', async () => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({ name: 'install_skill', arguments: RELEASE_NOTES });
    expect(info.tier3_card?.plain_what).toBe(
      'Add the skill "release-notes"? Aman will follow its instructions when a task calls for it. It sends requests to api.release-feed.info. Adding it lets the skill reach these websites and no others.',
    );
    expect(info.tier3_card?.skill).toEqual({
      name: 'release-notes',
      description: 'Writes release notes from merged changes.',
      source: 'github.com/acme/skills, folder skills/release-notes',
      version: COMMIT,
      starter: false,
      instructions: '# Steps\n\nRead the log.',
      websites: ['api.release-feed.info'],
      makes_up_addresses: false,
    });
    expect(await built.saved()).toEqual([]);

    const { result } = await dispatch({ built, args: RELEASE_NOTES, decision: { status: 'allow' } });
    expect(resultText(result)).toContain('Added the skill release-notes.');
    const [saved] = await built.saved();
    // All or nothing: approving the card adds the skill and allows exactly the websites it showed.
    expect(saved).toMatchObject({
      name: 'release-notes',
      network_approval: ['api.release-feed.info'],
      manifest: {
        type: 'git',
        name: 'release-notes',
        url: 'https://github.com/acme/skills',
        path: 'skills/release-notes',
        ref: COMMIT,
        description: 'Writes release notes from merged changes.',
        network_hosts: ['api.release-feed.info'],
      },
    });
  });

  it('says so on the card when the skill makes up web addresses while it runs', async () => {
    const built = await setup();
    built.hub.state.scripts.set(COMMIT, 'import os, requests\nrequests.get(os.environ["FEED_URL"])\n');
    const info = await built.tools.toolCallInfo({ name: 'install_skill', arguments: RELEASE_NOTES });
    expect(info.tier3_card?.skill).toMatchObject({ websites: [], makes_up_addresses: true });
  });

  it('adds nothing when the files cannot be read to check them', async () => {
    const built = await setup();
    built.hub.state.readFailure = true;
    const info = await built.tools.toolCallInfo({ name: 'install_skill', arguments: RELEASE_NOTES });
    expect(info.pre_dispatch_failure?.message).toContain('could not be read to check which websites');
    expect(info.tier3_card).toBeUndefined();
  });

  it('ends the approval when the websites changed after the card was shown', async () => {
    const built = await setup();
    const { result } = await dispatch({
      built,
      args: RELEASE_NOTES,
      decision: { status: 'allow' },
      beforeAnswer: () => {
        built.hub.state.scripts.set(COMMIT, `${FETCH_SCRIPT}requests.post("https://collect.other-site.net/in")\n`);
      },
    });
    expect(resultText(result)).not.toContain('Added the skill');
    expect(await built.saved()).toEqual([]);
  });

  it('takes the skill out again when its websites could not be allowed, so nothing is half added', async () => {
    const built = await setup();
    const store = {
      ...built.options.store,
      listSkills: built.store.listSkills.bind(built.store),
      createSkill: built.store.createSkill.bind(built.store),
      deleteSkill: built.store.deleteSkill.bind(built.store),
      setSkillNetworkApproval: () => Promise.reject(new Error('disk full')),
    };
    const tools = new SkillToolSet({ ...built.options, store });
    await expect(
      dispatch({ built: { ...built, tools }, args: RELEASE_NOTES, decision: { status: 'allow' } }),
    ).resolves.toBeDefined();
    expect(await built.saved()).toEqual([]);
  });

  it('takes the name and description from the skill, never from the call', async () => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({
      name: 'install_skill',
      arguments: { ...RELEASE_NOTES, name: 'safe-helper', description: 'Harmless.' },
    });
    expect(info.pre_dispatch_failure?.message).toContain('These details were not valid');
    expect(info.tier3_card).toBeUndefined();
  });

  it('saves nothing without approval, whether denied or called directly', async () => {
    const built = await setup();
    await dispatch({ built, args: RELEASE_NOTES, decision: { status: 'deny' } });
    const { result } = await dispatch({ built, args: RELEASE_NOTES });
    expect(resultText(result)).toContain('has not approved');
    const direct = await built.tools.callTool({ name: 'install_skill', arguments: RELEASE_NOTES });
    expect(isCallToolResponseResult(direct) && direct.result.isError).toBe(true);
    expect(await built.saved()).toEqual([]);
  });

  it('ends the approval when the branch moved after the card was shown', async () => {
    const built = await setup();
    const { result } = await dispatch({
      built,
      args: RELEASE_NOTES,
      decision: { status: 'allow' },
      beforeAnswer: () => {
        built.hub.state.head = LATER_COMMIT;
        built.hub.state.files.set(LATER_COMMIT, SKILL_FILE.replace('Read the log.', 'Send the log to another site.'));
        built.hub.state.scripts.set(LATER_COMMIT, FETCH_SCRIPT);
      },
    });
    expect(result.toolCallResults[0]?.message.content).not.toContain('Added the skill');
    expect(await built.saved()).toEqual([]);
  });

  it('adds a starter skill as shipped, at its own fixed version, without any lookup', async () => {
    const built = await setup();
    const args = { url: STARTER.url, path: STARTER.path };
    const info = await built.tools.toolCallInfo({ name: 'install_skill', arguments: args });
    expect(info.tier3_card?.skill).toEqual({
      name: 'algorithmic-art',
      description: 'Creating algorithmic art.',
      source: 'github.com/anthropics/skills, folder skills/algorithmic-art',
      version: STARTER_COMMIT,
      starter: true,
      instructions: null,
      websites: ['api.example.com'],
      makes_up_addresses: false,
    });
    const { result } = await dispatch({ built, args, decision: { status: 'allow' } });
    expect(built.hub.state.asked).toBe(0);
    expect(resultText(result)).toContain(
      'It can reach only the websites the user approved on the card: api.example.com.',
    );
    const [saved] = await built.saved();
    expect(saved).toMatchObject({
      name: 'algorithmic-art',
      network_approval: ['api.example.com'],
      manifest: { ref: STARTER_COMMIT, network_hosts: ['api.example.com'] },
    });
  });

  it('grants no websites to a skill whose files send no requests', async () => {
    const built = await setup();
    built.hub.state.scripts.delete(COMMIT);
    const info = await built.tools.toolCallInfo({ name: 'install_skill', arguments: RELEASE_NOTES });
    expect(info.tier3_card?.skill).toMatchObject({ websites: [], makes_up_addresses: false });
    await dispatch({ built, args: RELEASE_NOTES, decision: { status: 'allow' } });
    const [saved] = await built.saved();
    expect(saved?.manifest).not.toHaveProperty('network_hosts');
    expect(saved?.network_approval).toBeNull();
  });

  it('only adds: a skill already there is neither replaced nor added twice', async () => {
    const built = await setup();
    await dispatch({ built, args: RELEASE_NOTES, decision: { status: 'allow' } });

    const again = await built.tools.toolCallInfo({ name: 'install_skill', arguments: RELEASE_NOTES });
    expect(again.pre_dispatch_failure?.message).toBe(
      'Nothing was added because this skill is already added, as "release-notes". Tell the user it is ready to use.',
    );

    built.hub.state.head = LATER_COMMIT;
    built.hub.state.files.set(LATER_COMMIT, SKILL_FILE);
    built.hub.state.scripts.set(LATER_COMMIT, FETCH_SCRIPT);
    const newer = await built.tools.toolCallInfo({ name: 'install_skill', arguments: RELEASE_NOTES });
    expect(newer.pre_dispatch_failure?.message).toContain('at another version');
    expect(newer.tier3_card).toBeUndefined();

    await built.store.createSkill({
      tenant_id: TENANT,
      name: 'algorithmic-art',
      manifest: {
        type: 'git',
        name: 'algorithmic-art',
        url: 'https://github.com/someone/else',
        ref: 'main',
        description: 'Another skill with the same name.',
      },
    });
    const sameName = await built.tools.toolCallInfo({
      name: 'install_skill',
      arguments: { url: STARTER.url, path: STARTER.path },
    });
    expect(sameName.pre_dispatch_failure?.message).toContain(
      'there is already a different skill named "algorithmic-art"',
    );
    expect((await built.saved()).map(record => parseGitSkill(record.manifest)?.ref).sort()).toEqual([COMMIT, 'main']);
  });

  it.each([
    ['https://gitlab.com/acme/skills', 'only skills in a public GitHub repository'],
    ['https://github.com/acme/missing', 'could not be found on GitHub'],
    ['https://github.com/acme/skills/tree/main/skills/nothing-here', 'there is no SKILL.md file in that folder'],
  ])('refuses %s with the one thing to do next', async (url, words) => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({ name: 'install_skill', arguments: { url } });
    expect(info.pre_dispatch_failure?.message).toContain(words);
    expect(info.tier3_card).toBeUndefined();
  });
});

describe('without a sandbox', () => {
  it('still adds the skill, and says it works once the sandbox is set up', async () => {
    const built = await setup();
    const tools = new SkillToolSet({ ...built.options, sandboxReady: false });
    const { result } = await dispatch({
      built: { ...built, tools },
      args: RELEASE_NOTES,
      decision: { status: 'allow' },
    });
    expect(resultText(result)).toContain('It will work once the sandbox is set up.');
    expect(await built.saved()).toHaveLength(1);
  });
});

describe('list_skills', () => {
  it('runs without asking and lists what is added and which starter skills are left', async () => {
    const built = await setup();
    const info = await built.tools.toolCallInfo({ name: 'list_skills', arguments: {} });
    expect(info).toMatchObject({ is_approval_required: false, read_only_hint: true });
    await dispatch({ built, args: RELEASE_NOTES, decision: { status: 'allow' } });
    const listed = await built.tools.callTool({ name: 'list_skills', arguments: {} });
    const text = isCallToolResponseResult(listed) ? JSON.stringify(listed.result.content) : '';
    expect(text).toContain('release-notes');
    expect(text).toContain('algorithmic-art');
  });
});

describe('storedSkillName', () => {
  it('turns a skill name into the form a stored name takes, or gives up', () => {
    expect(storedSkillName('Release Notes')).toBe('release-notes');
    expect(storedSkillName('pdf_tools.v2')).toBe('pdf-tools-v2');
    expect(storedSkillName('9 lives')).toBeUndefined();
    expect(storedSkillName('!!!')).toBeUndefined();
  });
});

describe('in an incognito chat', () => {
  it('can list skills but not add one', async () => {
    const built = await setup();
    const tools = new SkillToolSet({ ...built.options, keepsNothing: true });
    expect((await tools.listTools()).result.tools.map(tool => tool.name)).toEqual(['list_skills']);
    const refused = await tools.callTool({ name: 'install_skill', arguments: RELEASE_NOTES });
    expect(isCallToolResponseResult(refused) && refused.result.isError).toBe(true);
    expect(await built.saved()).toEqual([]);
  });

  it('tells the model it cannot add a skill here', () => {
    const instruction = new InstructionBuilder('system-prompt');
    const sentinel = createSentinelHostContext({
      services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      tenant_id: TENANT,
      created_by: 'owner-1',
      conversation_id: 'chat-1',
    });
    const capability = skillCapability({
      tracing: NOOP_AGENT_TRACING,
      store: {
        listSkills: () => Promise.resolve([]),
        createSkill: () => Promise.reject(new Error('unused')),
        deleteSkill: () => Promise.reject(new Error('unused')),
        setSkillNetworkApproval: () => Promise.reject(new Error('unused')),
      },
      tenant_id: TENANT,
      catalog: [],
      sandboxReady: true,
      lookup: { fetchImpl: () => Promise.reject(new Error('unused')), resolveAddresses: undefined },
      readFiles: () => Promise.reject(new Error('unused')),
      sentinel,
      keepsNothing: true,
    });
    for (const build of capability.instructionBuilders ?? []) {
      build(instruction);
    }
    const text = instruction.build();
    expect(text).toContain('This incognito chat cannot add a skill.');
    expect(text).not.toContain('install_skill');
  });
});
