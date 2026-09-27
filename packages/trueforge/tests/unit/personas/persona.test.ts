import {
  buildPersonaContext,
  findPersonaContentNameConflict,
  isPersonaDeterminer,
  matchPersonaInvocation,
  normalizePersonaContent,
  personaNameKeys,
  type Persona,
  type PersonaContent,
} from '../../../src/personas/persona';

function persona(overrides: Partial<Persona> & Pick<Persona, 'id' | 'display_name'>): Persona {
  return {
    tenant_id: 'default',
    created_by: 'user-a',
    aliases: [],
    instructions: 'Answer plainly.',
    model_name: 'scripted/model',
    created_at: '2026-08-27T00:00:00.000Z',
    updated_at: '2026-08-27T00:00:00.000Z',
    updated_by: 'user-a',
    ...overrides,
  };
}

const ZARA = persona({ id: 'p-zara', display_name: 'Zara', aliases: ['Z'], model_name: 'scripted/zara-model' });
const MILO = persona({ id: 'p-milo', display_name: 'Milo' });

describe('matchPersonaInvocation', () => {
  it.each([
    ['Zara, what do you think?'],
    ['zara, what do you think?'],
    ['Zara: what do you think?'],
    ['ask Zara what she thinks'],
    ['let me talk to Zara'],
    ['let me speak to Zara.'],
    ['I want to talk to Zara'],
    ['can i speak to zara?'],
    ['@Zara please review this'],
    ['  Zara, leading whitespace is still an address'],
  ])('activates on an explicit invocation: %s', text => {
    expect(matchPersonaInvocation({ text, personas: [ZARA, MILO] })?.persona.id).toBe('p-zara');
  });

  it.each([
    ['Zara is a clothing brand.'],
    ['I was reading about Zara yesterday.'],
    ['I should ask Zara about it tomorrow, but not now.'],
    ['We could talk to Zara later — remind me.'],
    ['Zarathustra was written by Nietzsche.'],
    ['Summarise the Zara filing.'],
    [''],
    ['   '],
  ])('leaves a casual mention alone: %s', text => {
    expect(matchPersonaInvocation({ text, personas: [ZARA, MILO] })).toBeUndefined();
  });

  it('matches a configured alias exactly as it matches the display name', () => {
    expect(matchPersonaInvocation({ text: 'Z, take this one', personas: [ZARA, MILO] })?.persona.id).toBe('p-zara');
  });

  it('picks the longest configured name, so a prefix never steals a longer one', () => {
    const zaraQuinn = persona({ id: 'p-zq', display_name: 'Zara Quinn' });
    const matched = matchPersonaInvocation({ text: 'Zara Quinn, hello', personas: [ZARA, zaraQuinn] });
    expect(matched?.persona.id).toBe('p-zq');
  });

  it('does not activate a persona that is merely a prefix of a longer word', () => {
    expect(matchPersonaInvocation({ text: 'ask Zaraphine about it', personas: [ZARA] })).toBeUndefined();
  });

  it('finds nothing when no personas are configured', () => {
    expect(matchPersonaInvocation({ text: 'Zara, hello', personas: [] })).toBeUndefined();
  });
});

describe('name folding is locale-independent and Unicode-normalising', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('matches an uppercase invocation on a host whose locale folds "I" to a dotless "ı"', () => {
    // The standard counter-example: with a Turkish default locale,
    // toLocaleLowerCase() folds "IRIS" to "ırıs", so the same configured name
    // would answer on one machine and be ignored on another.
    const fold = String.prototype.toLocaleLowerCase;
    jest.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
      return fold.call(this, 'tr-TR');
    });
    expect('IRIS'.toLocaleLowerCase()).not.toBe('iris');

    const iris = persona({ id: 'p-iris', display_name: 'Iris' });
    expect(matchPersonaInvocation({ text: 'IRIS, what changed?', personas: [iris] })?.persona.id).toBe('p-iris');
  });

  it.each([
    { name: 'Zara', text: 'Ｚａｒａ, hello', spelling: 'full-width letters' },
    { name: 'Sofia', text: 'Soﬁa, hello', spelling: 'an fi ligature' },
    { name: 'Zoë', text: 'Zoë, hello', spelling: 'a decomposed accent' },
    { name: 'Zara Quinn', text: 'Zara Quinn, hello', spelling: 'a non-breaking space' },
  ])('invokes $name when the message spells it with $spelling', ({ name, text }) => {
    const configured = persona({ id: 'p-normalised', display_name: name });
    expect(matchPersonaInvocation({ text, personas: [configured] })?.persona.id).toBe('p-normalised');
  });

  it('normalizes a compatibility spelling into its canonical reservation key', () => {
    expect(
      personaNameKeys({
        display_name: 'Ｚara',
        aliases: [],
        instructions: 'x',
        model_name: 'scripted/model',
      }),
    ).toEqual(['zara']);
  });
});

describe('normalizePersonaContent', () => {
  it('collapses whitespace while preserving distinct aliases', () => {
    const content: PersonaContent = {
      display_name: '  Zara   Quinn ',
      aliases: ['Z', 'Zed'],
      instructions: '  Answer plainly.  ',
      model_name: ' scripted/model ',
    };
    expect(normalizePersonaContent(content)).toEqual({
      display_name: 'Zara Quinn',
      aliases: ['Z', 'Zed'],
      instructions: 'Answer plainly.',
      model_name: 'scripted/model',
    });
  });

  it.each([
    { aliases: ['zara quinn'], description: 'the display name' },
    { aliases: ['Z', ' z '], description: 'another alias after folding' },
  ])('rejects an alias that duplicates $description', ({ aliases }) => {
    expect(() =>
      normalizePersonaContent({
        display_name: 'Zara Quinn',
        aliases,
        instructions: 'Answer plainly.',
        model_name: 'scripted/model',
      }),
    ).toThrow(/duplicates .* after trimming and case-folding/);
  });
});

describe('buildPersonaContext', () => {
  it('carries the identity and role, and names the exact model', () => {
    const context = buildPersonaContext(ZARA);
    expect(context.persona_id).toBe('p-zara');
    expect(context.model_name).toBe('scripted/zara-model');
    expect(context.injected_context).toContain('<persona-name>Zara</persona-name>');
    expect(context.injected_context).toContain('<persona-role>Answer plainly.</persona-role>');
  });

  it('says a persona changes who answers, not what it is allowed to do', () => {
    expect(buildPersonaContext(ZARA).injected_context).toContain(
      'not your tools, your approval rules, or your safety policy',
    );
  });

  it('frames the persona identity-first, with a positive claim and no negated identity', () => {
    const context = buildPersonaContext(ZARA).injected_context;

    expect(context).toContain('You are the configured persona named in <persona-name>');
    expect(context).not.toMatch(/you are not/i);
  });

  it('never interpolates the configured name into frame prose', () => {
    // The name reaches the prompt only inside the <persona-name> tag, so a
    // hostile name cannot break the frame's first sentence into an instruction.
    const firstParagraph = buildPersonaContext(ZARA).injected_context.split('\n\n')[0] ?? '';
    expect(firstParagraph).not.toContain('Zara');
  });

  it('strips ASCII control characters from instructions before rendering', () => {
    const context = buildPersonaContext(persona({ id: 'p-x', display_name: 'X', instructions: 'Be\x01helpful\x7F.' }));
    expect(context.injected_context).toContain('<persona-role>Behelpful.</persona-role>');
    expect(context.injected_context).not.toMatch(/[\x01\x7F]/);
  });

  it('makes the current persona authoritative over the style of earlier assistant turns', () => {
    const context = buildPersonaContext(ZARA).injected_context;

    expect(context).toContain('only active assistant identity');
    expect(context).toContain('Do not imitate their identity, voice, formatting, metaphors, or behavioral style');
  });
});

describe('matchPersonaInvocation switch grammar', () => {
  it.each([
    ['switch to Zara'],
    ['switch back to Zara'],
    ['speak with Zara'],
    ['please switch to Zara'],
    ['can you switch to Zara'],
    ['could you please switch back to Zara'],
    ['would you speak with Zara'],
    ['switch to my Zara'],
    ['switch to the Zara'],
    ['switch to a Zara'],
    ['switch to an Zara'],
    ['please switch to my Zara'],
    ['switch to Zara, take it from here'],
    ['switch to Zara.'],
  ])('matches the deterministic switch grammar: %s', text => {
    expect(matchPersonaInvocation({ text, personas: [ZARA, MILO] })?.persona.id).toBe('p-zara');
  });

  it.each([
    ['move to Zara'],
    ['change to Zara'],
    ['go back to Zara'],
    ['switch Zara'],
    ['switching to Zara'],
    ['I want to switch to Zara'],
    ['please move to Zara'],
  ])('does not match lookalike phrasing: %s', text => {
    expect(matchPersonaInvocation({ text, personas: [ZARA, MILO] })).toBeUndefined();
  });

  it('skips one determiner before an alias too', () => {
    expect(matchPersonaInvocation({ text: 'switch to the Z', personas: [ZARA, MILO] })?.persona.id).toBe('p-zara');
  });

  it('does not let the determiner skip match a longer word the name is a prefix of', () => {
    expect(matchPersonaInvocation({ text: 'switch to the Zed', personas: [ZARA, MILO] })).toBeUndefined();
  });

  it('matches only after a lead-in when leadInOnly is set', () => {
    const mannie = persona({ id: 'p-mannie', display_name: 'Mannie' });
    expect(
      matchPersonaInvocation({ text: 'Zara, what do you think?', personas: [ZARA], leadInOnly: true }),
    ).toBeUndefined();
    expect(
      matchPersonaInvocation({
        text: 'Mannie, I have a friend named Zara.',
        personas: [mannie],
        leadInOnly: true,
      }),
    ).toBeUndefined();
    expect(
      matchPersonaInvocation({ text: 'switch to Zara', personas: [ZARA], leadInOnly: true })?.persona.id,
    ).toBe('p-zara');
    expect(
      matchPersonaInvocation({ text: 'please switch back to Mannie', personas: [mannie], leadInOnly: true })?.persona
        .id,
    ).toBe('p-mannie');
  });
});

describe('invocation determiners', () => {
  it('recognises the shared determiner set', () => {
    for (const word of ['my', 'the', 'a', 'an']) {
      expect(isPersonaDeterminer(word)).toBe(true);
    }
    for (const word of ['', 'your', 'this', 'that', 'our', 'switch']) {
      expect(isPersonaDeterminer(word)).toBe(false);
    }
  });

  it('rejects a bare determiner as a display name', () => {
    const content: PersonaContent = {
      display_name: 'The',
      aliases: [],
      instructions: 'Answer plainly.',
      model_name: 'scripted/model',
    };
    expect(findPersonaContentNameConflict(content)).toEqual({
      aliasIndex: -1,
      alias: 'The',
      conflictsWith: 'invocation determiner',
      existingName: 'The',
    });
    expect(() => normalizePersonaContent(content)).toThrow('The');
  });

  it('rejects a bare determiner as an alias', () => {
    const content: PersonaContent = {
      display_name: 'Zara',
      aliases: ['my'],
      instructions: 'Answer plainly.',
      model_name: 'scripted/model',
    };
    expect(findPersonaContentNameConflict(content)).toEqual({
      aliasIndex: 0,
      alias: 'my',
      conflictsWith: 'invocation determiner',
      existingName: 'my',
    });
  });
});
