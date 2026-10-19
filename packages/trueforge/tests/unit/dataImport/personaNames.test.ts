import { z } from 'zod';

import { repairPersonaNames } from '../../../src/dataImport/personaNames';
import { PersonaContentSchema } from '../../../src/schemas/persona';

/** A personas.json entry as an older version wrote it; only the name fields matter here. */
function entry(displayName: unknown, aliases: unknown[] = []): Record<string, unknown> {
  return {
    persona: { id: `persona-${String(displayName)}`, display_name: displayName, aliases },
    knowledge: { documents: [] },
  };
}

const NamesSchema = z.array(
  z.object({ persona: z.object({ display_name: z.string(), aliases: z.array(z.string()) }) }),
);

/** The names a repaired section holds, read as strings; every entry in these tests is a string. */
function namesOf(json: unknown): { display_name: string; aliases: string[] }[] {
  return NamesSchema.parse(json).map(({ persona }) => persona);
}

/** Every repaired persona must pass the same content check an app-created persona does. */
function expectAcceptedByAppRules(json: unknown): void {
  for (const { display_name, aliases } of namesOf(json)) {
    const content = { display_name, aliases, instructions: 'Keep notes.', model_name: 'provider/model' };
    expect(PersonaContentSchema.safeParse(content).success).toBe(true);
  }
}

describe('repairPersonaNames', () => {
  it('leaves names that already fit exactly as they are, with nothing reported', () => {
    const input = [entry('Zara Quinn', ['Zara', 'Quinn'])];
    const { json, lines } = repairPersonaNames(input);
    expect(json).toEqual(input);
    expect(lines).toEqual([]);
  });

  it('passes a value that is not a list through, so the strict read still refuses it', () => {
    const input = { persona: 'not a list' };
    expect(repairPersonaNames(input)).toEqual({ json: input, lines: [] });
  });

  it('replaces characters the rules refuse with a space, then collapses and trims', () => {
    const { json, lines } = repairPersonaNames([entry('Dr. Kim & Co')]);
    expect(namesOf(json)).toEqual([{ display_name: 'Dr Kim Co', aliases: [] }]);
    expect(lines).toEqual([
      `Renamed the persona "Dr. Kim & Co" to "Dr Kim Co", because names can only use letters, numbers, spaces, _ - and '.`,
    ]);
    expectAcceptedByAppRules(json);
  });

  it('turns an emoji into a space and keeps the letters around it', () => {
    const { json, lines } = repairPersonaNames([entry('Zara 🌟 Quinn')]);
    expect(namesOf(json)[0]?.display_name).toBe('Zara Quinn');
    expect(lines).toHaveLength(1);
  });

  it('drops a leading symbol that the rules do not allow at the start', () => {
    const { json, lines } = repairPersonaNames([entry('_Nova')]);
    expect(namesOf(json)[0]?.display_name).toBe('Nova');
    expect(lines).toEqual(['Renamed the persona "_Nova" to "Nova", because names must start with a letter or number.']);
  });

  it('turns a leading symbol the rules refuse into a space, then drops it', () => {
    const { json, lines } = repairPersonaNames([entry('*Nova')]);
    expect(namesOf(json)[0]?.display_name).toBe('Nova');
    expect(lines).toEqual([
      `Renamed the persona "*Nova" to "Nova", because names can only use letters, numbers, spaces, _ - and '.`,
    ]);
  });

  it('cuts a name over 48 characters to 48', () => {
    const long = 'abcdefghij'.repeat(6);
    const { json, lines } = repairPersonaNames([entry(long)]);
    expect(namesOf(json)[0]?.display_name).toBe(long.slice(0, 48));
    expect(lines).toEqual([
      `Renamed the persona "${long}" to "${long.slice(0, 48)}", because names can be at most 48 characters.`,
    ]);
    expectAcceptedByAppRules(json);
  });

  it('counts characters the way the name schema does, so a letter that takes two units is one character', () => {
    // 60 astral letters are 120 UTF-16 units but 60 characters: the schema refuses them, and the cut keeps 48 whole letters.
    const { json } = repairPersonaNames([entry(`A${'𝒜'.repeat(60)}`)]);
    expect(namesOf(json)[0]?.display_name).toBe(`A${'𝒜'.repeat(47)}`);
    expectAcceptedByAppRules(json);
  });

  it('accepts a name of 48 characters that is over 48 UTF-16 units, as the schema does', () => {
    const name = '𝒜'.repeat(48);
    const { json, lines } = repairPersonaNames([entry(name)]);
    expect(json).toEqual([entry(name)]);
    expect(lines).toEqual([]);
  });

  it('gives a name that is only the word "The" a number, because "my", "the", "a" and "an" can\'t be names on their own', () => {
    const { json, lines } = repairPersonaNames([entry('The')]);
    expect(namesOf(json)[0]?.display_name).toBe('Persona 1');
    expect(lines).toEqual([
      'Renamed the persona "The" to "Persona 1", because "my", "the", "a" and "an" can\'t be names on their own.',
    ]);
    expectAcceptedByAppRules(json);
  });

  it('gives a name with no letters or numbers a number', () => {
    const { json, lines } = repairPersonaNames([entry('!!!')]);
    expect(namesOf(json)[0]?.display_name).toBe('Persona 1');
    expect(lines).toEqual(['Renamed the persona "!!!" to "Persona 1", because it has no letters or numbers.']);
  });

  it('numbers the fallback name past any number a persona already uses', () => {
    const { json } = repairPersonaNames([entry('Persona 1'), entry('The')]);
    expect(namesOf(json).map(item => item.display_name)).toEqual(['Persona 1', 'Persona 2']);
  });

  it('gives two personas that repair to the same name different numbers', () => {
    const { json, lines } = repairPersonaNames([entry('Dr. Kim'), entry('Dr Kim')]);
    expect(namesOf(json).map(item => item.display_name)).toEqual(['Dr Kim 2', 'Dr Kim']);
    expect(lines).toEqual([
      `Renamed the persona "Dr. Kim" to "Dr Kim 2", because another persona already uses that name, and names can only use letters, numbers, spaces, _ - and '.`,
    ]);
    expectAcceptedByAppRules(json);
  });

  it('says both reasons when a repaired name also clashes', () => {
    const { json, lines } = repairPersonaNames([entry('Dr Kim'), entry('Dr! Kim')]);
    expect(namesOf(json).map(item => item.display_name)).toEqual(['Dr Kim', 'Dr Kim 2']);
    expect(lines).toEqual([
      `Renamed the persona "Dr! Kim" to "Dr Kim 2", because another persona already uses that name, and names can only use letters, numbers, spaces, _ - and '.`,
    ]);
  });

  it("drops an alias that repairs to empty, reserved, or the persona's own name", () => {
    const { json, lines } = repairPersonaNames([entry('Zara Quinn', ['!!', 'the', 'Zara. Quinn', 'Zara'])]);
    expect(namesOf(json)[0]?.aliases).toEqual(['Zara']);
    expect(lines).toEqual([
      'Dropped the persona alias "!!" of the persona "Zara Quinn", because it has no letters or numbers.',
      'Dropped the persona alias "the" of the persona "Zara Quinn", because "my", "the", "a" and "an" can\'t be names on their own.',
      `Dropped the persona alias "Zara. Quinn" of the persona "Zara Quinn", because it is the same as the persona's own name.`,
    ]);
    expectAcceptedByAppRules(json);
  });

  it('drops an alias that repeats another alias of the same persona, after case-folding', () => {
    const { json, lines } = repairPersonaNames([entry('Zara', ['Quinn', 'QUINN'])]);
    expect(namesOf(json)[0]?.aliases).toEqual(['Quinn']);
    expect(lines).toEqual([
      `Dropped the persona alias "QUINN" of the persona "Zara", because it is already one of the persona's aliases.`,
    ]);
  });

  it('drops an alias another persona already uses, and keeps the persona that claimed it first', () => {
    const { json, lines } = repairPersonaNames([entry('Zara', ['Nova']), entry('Nova', ['Quinn'])]);
    expect(namesOf(json)).toEqual([
      { display_name: 'Zara', aliases: [] },
      { display_name: 'Nova', aliases: ['Quinn'] },
    ]);
    expect(lines).toEqual([
      'Dropped the persona alias "Nova" of the persona "Zara", because another persona already uses that name.',
    ]);
  });

  it('gives a repaired alias no place when a persona name that fits already holds it', () => {
    const { json } = repairPersonaNames([entry('Zara', ['Dr. Kim']), entry('Dr Kim')]);
    expect(namesOf(json)[0]?.aliases).toEqual([]);
  });

  it('leaves a value it cannot read as a persona for the strict read to refuse', () => {
    const input = [entry(7), entry('Zara', [42])];
    const { json, lines } = repairPersonaNames(input);
    expect(json).toEqual(input);
    expect(lines).toEqual([]);
  });

  it('keeps a name whose only change is its Unicode form, and reports nothing', () => {
    // The decomposed é has a combining mark, so it does not fit as typed, but composing it is not a visible change.
    const { json, lines } = repairPersonaNames([entry('e\u0301tienne')]);
    expect(namesOf(json)[0]?.display_name).toBe('\u00e9tienne');
    expect(lines).toEqual([]);
    expectAcceptedByAppRules(json);
  });

  it('drops an alias that is only the word "the" with spaces around it, reporting the reason and no length', () => {
    const { json, lines } = repairPersonaNames([entry('Zara', [' the '])]);
    expect(namesOf(json)[0]?.aliases).toEqual([]);
    expect(lines).toEqual([
      `Dropped the persona alias " the " of the persona "Zara", because "my", "the", "a" and "an" can't be names on their own.`,
    ]);
  });

  it('gives a name in an Indic script a number and says why, without deleting any of its marks', () => {
    const { json, lines } = repairPersonaNames([entry('हिन्दी', ['हिन्दी'])]);
    expect(namesOf(json)[0]).toEqual({ display_name: 'Persona 1', aliases: [] });
    expect(lines).toEqual([
      'Renamed the persona "हिन्दी" to "Persona 1", because it uses characters that names cannot hold now.',
      'Dropped the persona alias "हिन्दी" of the persona "Persona 1", because it uses characters that names cannot hold now.',
    ]);
  });

  it('keeps a valid alias rather than give its key to a name that has to be generated', () => {
    const { json, lines } = repairPersonaNames([entry('Dr. Kim'), entry('Zara', ['Dr Kim'])]);
    expect(namesOf(json)).toEqual([
      { display_name: 'Dr Kim 2', aliases: [] },
      { display_name: 'Zara', aliases: ['Dr Kim'] },
    ]);
    expect(lines).toEqual([
      `Renamed the persona "Dr. Kim" to "Dr Kim 2", because another persona already uses that name, and names can only use letters, numbers, spaces, _ - and '.`,
    ]);
  });

  it('drops an alias that is the persona’s own name even when the name was repaired from it', () => {
    const { json, lines } = repairPersonaNames([entry('Dr. Kim', ['Dr Kim'])]);
    expect(namesOf(json)).toEqual([{ display_name: 'Dr Kim', aliases: [] }]);
    expect(lines).toEqual([
      `Renamed the persona "Dr. Kim" to "Dr Kim", because names can only use letters, numbers, spaces, _ - and '.`,
      `Dropped the persona alias "Dr Kim" of the persona "Dr Kim", because it is the same as the persona's own name.`,
    ]);
  });

  it('reports a repeated blank alias once', () => {
    const { json, lines } = repairPersonaNames([entry('Zara', ['  ', ' '])]);
    expect(namesOf(json)[0]?.aliases).toEqual([]);
    expect(lines).toEqual([
      'Dropped the persona alias "  " of the persona "Zara", because it has no letters or numbers.',
    ]);
  });
});
