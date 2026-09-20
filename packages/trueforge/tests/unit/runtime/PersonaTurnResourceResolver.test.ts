import { AgentSpecSchema, type AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import type { AgentCapability, ILLM } from '@truefoundry/trueforge-core/core';
import { InstructionBuilder } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';
import {
  buildPersonalizationContext,
  personalizationDigest,
  type PersonalizationProfile,
} from '../../../src/personalization/profile';
import { buildPersonaContext, type Persona } from '../../../src/personas/persona';
import { PersonaTurnResourceResolver } from '../../../src/runtime/PersonaTurnResourceResolver';

const CHAT_MODEL = 'scripted/chat-model';
const PERSONA_MODEL = 'scripted/persona-model';
const DELEGATION_MODEL = 'scripted/delegation-model';
const COMPACTION_MODEL = 'scripted/compaction-model';

/** Distinguishable, structurally complete stand-ins: inference is intentionally not exercised. */
const clientNames = new WeakMap<ILLM, string>();

function clientFor(name: string): ILLM {
  const client: ILLM = {
    create: () => {
      throw new Error('unused test model stream');
    },
    createNonStream: () => Promise.reject(new Error('unused test model completion')),
  };
  clientNames.set(client, name);
  return client;
}

function clientName(client: ILLM | undefined): string | undefined {
  return client === undefined ? undefined : clientNames.get(client);
}

const PERSONA: Persona = {
  tenant_id: 'default',
  id: 'p-zara',
  created_by: 'user-a',
  display_name: 'Zara',
  aliases: [],
  instructions: 'Answer as a careful archivist.',
  model_name: PERSONA_MODEL,
  created_at: '2026-08-27T00:00:00.000Z',
  updated_at: '2026-08-27T00:00:00.000Z',
  updated_by: 'user-a',
};

const PERSONALIZATION: PersonalizationProfile = {
  tenant_id: 'default',
  created_by: 'user-a',
  assistant_name: 'Testinatrix',
  assistant_identity: 'A pirate software tester.',
  voice_guidance: 'Use pirate language and QA metaphors.',
  user_profile: 'Prefers plain English.',
  pinned_preferences: ['Keep advice practical.'],
  learned_profile: 'The user values calm explanations.',
  learning_enabled: false,
  revision: 3,
  digest: '',
  created_at: '2026-08-27T00:00:00.000Z',
  updated_at: '2026-08-27T00:00:00.000Z',
  updated_by: 'user-a',
};

function makeResolver(persona: Persona | undefined, personalization?: PersonalizationProfile) {
  const requested: string[] = [];
  const resolver = new PersonaTurnResourceResolver(
    {
      llm: name => {
        requested.push(name);
        return Promise.resolve({
          modelClient: clientFor(name),
          defaultModelParams: { temperature: name === PERSONA_MODEL ? 0.1 : 0.9 },
          modelId: undefined,
          modelSupportsVision: false,
        });
      },
      mcp: () => Promise.reject(new Error('unused')),
      mcpRequestTimeoutMs: 1_000,
      mcpConnectTimeoutMs: 1_000,
      logger: createLogger({ silent: true }),
    },
    personalization === undefined
      ? undefined
      : buildPersonalizationContext(
          { ...personalization, digest: personalizationDigest(personalization) },
          { speaker: persona === undefined ? 'default_assistant' : 'persona' },
        ),
    persona === undefined ? undefined : buildPersonaContext(persona),
  );
  return { resolver, requested };
}

/** Only the fields these scenarios vary; the schema fills every default. */
function makeSpec(
  overrides: {
    auxiliary_models?: { compaction?: { name: string }; delegation?: { name: string } };
    config?: { context_management?: { compaction?: { enabled: boolean } } };
  } = {},
): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: CHAT_MODEL, params: { temperature: 0.9 } },
    instructions: 'Answer the user.',
    ...overrides,
  });
}

function resolve(resolver: PersonaTurnResourceResolver, spec: AgentSpec, subAgent = false) {
  return resolver.resolveAgentDefinition({
    spec,
    ...(subAgent ? { agent_info: { type: 'dynamic' as const, name: 'reviewer', input: 'do the thing' } } : {}),
    signal: new AbortController().signal,
    tracing: resolver.createTracing(),
  });
}

/** Renders the capability's instruction section the way AgentThread would. */
function renderCapabilityInstructions(capabilities: readonly AgentCapability[]) {
  const builder = InstructionBuilder.createSystemPrompt('identity');
  for (const capability of capabilities) {
    for (const add of capability.instructionBuilders ?? []) {
      add(builder);
    }
  }
  return builder.build();
}

describe('PersonaTurnResourceResolver', () => {
  it('runs the root thread on the persona model and its own params, not the chat model', async () => {
    const { resolver } = makeResolver(PERSONA);
    const resolved = await resolve(resolver, makeSpec());

    expect(clientName(resolved.definition.modelClient)).toBe(PERSONA_MODEL);
    // Params travel with the selected model; the chat model's temperature does not follow.
    expect(resolved.definition.modelParams).toEqual({ temperature: 0.1 });
    // The identity prompt names the persona's model; with no resolver-supplied id the catalog
    // name loses its provider prefix.
    expect(resolved.definition.modelId).toBe('persona-model');
  });

  it('adds the persona as one escaped section, leaving the agent instructions in place', async () => {
    const { resolver } = makeResolver(PERSONA);
    const resolved = await resolve(resolver, makeSpec());

    expect(resolved.definition.instruction).toBe('Answer the user.');
    const rendered = renderCapabilityInstructions(resolved.extraCapabilities ?? []);
    expect(rendered).toContain('<persona-context>');
    expect(rendered).toContain('<![CDATA[');
    expect(rendered).toContain('<persona-name>Zara</persona-name>');
  });

  it('keeps user context but excludes the default assistant identity and voice on persona turns', async () => {
    const { resolver } = makeResolver(PERSONA, PERSONALIZATION);
    const resolved = await resolve(resolver, makeSpec());

    const rendered = renderCapabilityInstructions(resolved.extraCapabilities ?? []);
    expect(rendered).toContain('<user-profile>Prefers plain English.</user-profile>');
    expect(rendered).toContain('<pinned-preferences>');
    expect(rendered).toContain('The user values calm explanations.');
    expect(rendered).toContain('<persona-name>Zara</persona-name>');
    expect(rendered).not.toContain('<assistant-name>Testinatrix</assistant-name>');
    expect(rendered).not.toContain('<assistant-identity>A pirate software tester.</assistant-identity>');
    expect(rendered).not.toContain('<voice-guidance>Use pirate language and QA metaphors.</voice-guidance>');
  });

  it('leaves sub-agent threads to the delegation role', async () => {
    const { resolver } = makeResolver(PERSONA);
    const spec = makeSpec({ auxiliary_models: { delegation: { name: DELEGATION_MODEL } } });

    const resolved = await resolve(resolver, spec, true);

    expect(clientName(resolved.definition.modelClient)).toBe(DELEGATION_MODEL);
    expect(resolved.extraCapabilities ?? []).toHaveLength(0);
  });

  it('keeps compaction on the chat model when a persona is active and no compaction role is set', async () => {
    const { resolver } = makeResolver(PERSONA);
    const resolved = await resolve(resolver, makeSpec());

    // Not the persona model: a small persona picked for a few turns must not
    // quietly take over summarizing the whole thread.
    expect(clientName(resolved.compactionModel?.modelClient)).toBe(CHAT_MODEL);
    expect(resolved.compactionModel?.modelParams).toEqual({ temperature: 0.9 });
  });

  it('keeps an explicitly configured compaction role ahead of both the persona and the chat model', async () => {
    const { resolver } = makeResolver(PERSONA);
    const spec = makeSpec({ auxiliary_models: { compaction: { name: COMPACTION_MODEL } } });

    const resolved = await resolve(resolver, spec);

    expect(clientName(resolved.compactionModel?.modelClient)).toBe(COMPACTION_MODEL);
  });

  it('does not resolve a compaction client for a spec with compaction switched off', async () => {
    const { resolver, requested } = makeResolver(PERSONA);
    const spec = makeSpec({ config: { context_management: { compaction: { enabled: false } } } });

    const resolved = await resolve(resolver, spec);

    expect(resolved.compactionModel).toBeUndefined();
    expect(requested).toEqual([CHAT_MODEL, PERSONA_MODEL]);
  });

  it('keeps the default model and adds a root speaker guard even without a profile', async () => {
    const { resolver } = makeResolver(undefined);
    const resolved = await resolve(resolver, makeSpec());

    expect(clientName(resolved.definition.modelClient)).toBe(CHAT_MODEL);
    expect(resolved.compactionModel).toBeUndefined();
    const rendered = renderCapabilityInstructions(resolved.extraCapabilities ?? []);
    expect(rendered).toContain('<active-speaker-context>');
    expect(rendered).toContain('default assistant is the only active assistant identity');
    expect(rendered).toContain('Do not imitate their identity, voice, formatting, metaphors, or behavioral style');
  });

  it('leaves tool sets and the iteration limit exactly as the spec states them', async () => {
    const { resolver } = makeResolver(PERSONA);
    const withPersona = await resolve(resolver, makeSpec());
    const { resolver: plain } = makeResolver(undefined);
    const withoutPersona = await resolve(plain, makeSpec());

    expect(withPersona.definition.toolSets).toEqual(withoutPersona.definition.toolSets);
    expect(withPersona.definition.iterationLimit).toBe(withoutPersona.definition.iterationLimit);
    expect(withPersona.definition.responseFormat).toEqual(withoutPersona.definition.responseFormat);
  });

  it('fails visibly when the persona model is unavailable rather than answering on another', async () => {
    const resolver = new PersonaTurnResourceResolver(
      {
        llm: name =>
          name === PERSONA_MODEL
            ? Promise.reject(new Error(`Unknown model "${name}" — not configured on provider`))
            : Promise.resolve({
                modelClient: clientFor(name),
                defaultModelParams: {},
                modelId: undefined,
                modelSupportsVision: false,
              }),
        mcp: () => Promise.reject(new Error('unused')),
        mcpRequestTimeoutMs: 1_000,
        mcpConnectTimeoutMs: 1_000,
        logger: createLogger({ silent: true }),
      },
      undefined,
      buildPersonaContext(PERSONA),
    );

    await expect(resolve(resolver, makeSpec())).rejects.toThrow(`Unknown model "${PERSONA_MODEL}"`);
  });
});
