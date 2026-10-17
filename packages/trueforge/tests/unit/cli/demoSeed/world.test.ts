import { dayInZone, parseIsoDay, type CalendarDay } from '../../../../src/cli/demoSeed/calendar';
import { buildDemoWorld, DEFAULT_DEMO_TIME_ZONE, DEMO_MARKER } from '../../../../src/cli/demoSeed/world';
import { PersonaContentSchema } from '../../../../src/schemas/persona';
import { PersonalizationProfileContentSchema } from '../../../../src/schemas/personalization';
import { SpaceContentSchema } from '../../../../src/schemas/space';

const MODEL_NAME = 'demo-provider/demo-model';
const MONDAY: CalendarDay = { year: 2026, month: 10, day: 26 };

function worldOn(today: CalendarDay, timeZone = 'Europe/Lisbon') {
  return buildDemoWorld({ today, timeZone, modelName: MODEL_NAME });
}

function day(text: string): CalendarDay {
  const parsed = parseIsoDay(text);
  if (parsed === undefined) {
    throw new Error(`Not a day: ${text}`);
  }
  return parsed;
}

function tasksBody(world: ReturnType<typeof worldOn>): string {
  const space = world.spaces.find(candidate => candidate.content.name === 'Tasks');
  if (space === undefined) {
    throw new Error('No Tasks space');
  }
  return space.content.body;
}

function noteBody(world: ReturnType<typeof worldOn>, key: string): string {
  const note = world.notes.find(candidate => candidate.key === key);
  if (note === undefined) {
    throw new Error(`No note ${key}`);
  }
  return note.body;
}

describe('buildDemoWorld dates', () => {
  it('dates the tasks from the seed day', () => {
    const body = tasksBody(worldOn(MONDAY));

    expect(body).toContain('- [ ] Find English-speaking GP (in progress)\n  GP appointment Thu Oct 22, 2026, 09:30');
    expect(body).toContain('- [x] Get NIF (tax number) - done Sunday, October 18');
    expect(noteBody(worldOn(MONDAY), 'newcomers')).toContain('Thursday, Nov 5 at Café do Cais');
  });

  it('keeps the GP appointment on its fixed date whatever day the seed runs', () => {
    for (const seedDay of ['2026-10-19', '2026-10-20', '2026-11-02']) {
      expect(tasksBody(worldOn(day(seedDay)))).toContain('GP appointment Thu Oct 22, 2026, 09:30');
    }
  });

  it('changes only dated content when the day moves', () => {
    const first = worldOn(MONDAY);
    const later = worldOn(day('2026-11-02'));

    const changed = first.notes.filter(note => noteBody(later, note.key) !== note.body).map(note => note.key);
    expect(changed).toEqual(['newcomers']);
    expect(tasksBody(later)).not.toBe(tasksBody(first));
    expect(later.day).toBe('2026-11-02');
  });

  it('reads the day in the user zone when a caller derives it from the clock', () => {
    // 23:30 UTC on Oct 25 is already Oct 26 in Madrid and still Oct 25 in Lisbon on UTC+0.
    const now = new Date('2026-10-25T23:30:00Z');

    expect(worldOn(dayInZone({ now, timeZone: 'Europe/Madrid' })).day).toBe('2026-10-26');
    expect(worldOn(dayInZone({ now, timeZone: 'Europe/Lisbon' })).day).toBe('2026-10-25');
  });
});

describe('buildDemoWorld content', () => {
  it('lives in Lisbon', () => {
    expect(DEFAULT_DEMO_TIME_ZONE).toBe('Europe/Lisbon');
  });

  it('seeds a Morning brief that reads calendar and inbox, drafts replies and never sends', () => {
    const { scheduleManifest } = worldOn(MONDAY, DEFAULT_DEMO_TIME_ZONE);

    expect(scheduleManifest).toMatchObject({ cron: '30 7 * * *', timezone: 'Europe/Lisbon', status: 'active' });
    expect(scheduleManifest.task).toContain('calendar for today and my inbox');
    expect(scheduleManifest.task).toContain('Draft a reply');
    expect(scheduleManifest.task).toContain('do not send anything');
    expect(scheduleManifest.task).toContain('Needs your OK');
    expect(scheduleManifest.task).toContain('Flag upcoming appointments and what to bring');
    expect(scheduleManifest.task).toContain('Rua da Emenda 45, 1200-169 Lisboa');
  });

  it('seeds the two personas with a knowledge vault each', () => {
    const world = worldOn(MONDAY);

    expect(world.personas.map(persona => persona.content.display_name)).toEqual(['June', 'Theo']);
    const [june, theo] = world.personas;
    expect(june?.knowledge.map(document => document.title)).toContain('Visa and residence permit checklist');
    expect(june?.knowledge.map(document => document.title)).toContain('Emergency numbers and key phrases');
    expect(theo?.knowledge.map(document => document.title)).toContain('Twelve places to shoot in Lisbon');
    const twelve = theo?.knowledge.find(document => document.title === 'Twelve places to shoot in Lisbon');
    expect(twelve?.text.match(/^\d+\. /gm)).toHaveLength(12);
    expect(june?.content.model_name).toBe(MODEL_NAME);
  });

  it('keeps the vaults free of dates, so a new day does not rebuild a library', () => {
    expect(worldOn(MONDAY).personas.map(persona => persona.knowledge)).toEqual(
      worldOn(day('2026-12-01')).personas.map(persona => persona.knowledge),
    );
  });

  it('writes one memory note per fact with unique keys the vault accepts', () => {
    const { notes } = worldOn(MONDAY);

    expect(notes).toHaveLength(22);
    expect(new Set(notes.map(note => note.key)).size).toBe(notes.length);
    for (const note of notes) {
      expect(note.key).toMatch(/^[a-z0-9-]+$/);
    }
    expect(notes.map(note => note.body).join('\n')).toContain('allergic to penicillin');
    expect(noteBody(worldOn(MONDAY), 'gp-search')).toContain('do not suggest it as a GP');
  });

  it('produces content the real schemas accept', () => {
    const world = worldOn(MONDAY);

    for (const persona of world.personas) {
      expect(PersonaContentSchema.safeParse(persona.content).success).toBe(true);
    }
    expect(PersonalizationProfileContentSchema.safeParse(world.profile).success).toBe(true);
    for (const space of world.spaces) {
      expect(SpaceContentSchema.safeParse(space.content).success).toBe(true);
      expect(space.id.startsWith('demo-synthetic-')).toBe(true);
    }
    expect(world.profile.user_profile).toContain(DEMO_MARKER);
  });

  it('turns the sandbox on for the agent and tells every voice to degrade to plain text', () => {
    const world = worldOn(MONDAY);

    expect(world.agentSpec.config?.sandbox?.enabled).toBe(true);
    for (const text of [world.agentSpec.instructions, ...world.personas.map(persona => persona.content.instructions)]) {
      expect(text).toContain('run_code');
      expect(text).toContain('If run_code is not available');
      expect(text).toContain('connected Google account');
      expect(text).toContain('leave every send for her OK');
    }
  });

  it('books the GP in the tasks and starts trips from the rental', () => {
    const world = worldOn(MONDAY);

    expect(tasksBody(world)).toContain(
      'GP appointment Thu Oct 22, 2026, 09:30 at Brightwater Family Clinic with Dra. Helena Rocha',
    );
    expect(noteBody(world, 'short-term-rental')).toContain('Rua da Emenda 45, 1200-169 Lisboa, in Chiado');
  });
});
