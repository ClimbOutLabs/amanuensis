import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { parseDateOnly, type CalendarDay } from '@truefoundry/trueforge-core/core/util/calendarDay';
import { dayInZone } from '../../../../src/cli/demoSeed/calendar';
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
  const parsed = parseDateOnly(text);
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
  it('pins every date her mail and calendar own to the demo mailbox week, whatever day the seed runs', () => {
    const body = tasksBody(worldOn(day('2026-10-19')));

    expect(body).toContain('GP appointment Thursday, October 22, 2026, 09:30');
    expect(body).toContain('Appointment Oct 21, 10:00 at Amoreira Health Check');
    expect(body).toContain('Sessions: Oct 23 Alfama sunrise, Oct 24 Miradouro da Graça golden hour, Oct 31 Belém');
    expect(body).toContain('Pick up the 35mm-equivalent camera lens - due Thursday, October 22');
    expect(body).toContain('- [x] Get NIF (tax number) - done Sunday, October 11');
    expect(tasksBody(worldOn(day('2026-10-21')))).toBe(body);
    expect(tasksBody(worldOn(day('2026-11-30')))).toBe(tasksBody(worldOn(day('2026-10-23'))));
  });

  it('shows the GP visit as done, not in progress, once the seed day is past it', () => {
    expect(tasksBody(worldOn(day('2026-10-22')))).toContain('- [ ] Find English-speaking GP (in progress)');

    const after = tasksBody(worldOn(day('2026-10-23')));
    expect(after).toContain('- [x] Find English-speaking GP - done Thursday, October 22');
    expect(after).not.toContain('Find English-speaking GP (in progress)');
  });

  it('keeps every memory note the same when the day moves', () => {
    const first = worldOn(MONDAY);
    const later = worldOn(day('2026-11-02'));

    expect(later.notes).toEqual(first.notes);
    expect(noteBody(first, 'newcomers')).toContain('Thursday, Oct 29 at Café do Cais');
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

  // Scheduled runs are never offered Gmail drafting or sending, so the brief may only suggest replies in its text.
  it('seeds a Morning brief that reads calendar and inbox, suggests replies and never sends or saves', () => {
    const { scheduleManifest } = worldOn(MONDAY, DEFAULT_DEMO_TIME_ZONE);

    expect(scheduleManifest).toMatchObject({ cron: '30 7 * * *', timezone: 'Europe/Lisbon', status: 'active' });
    // The canonical brief comes first; the seed adds only its home address and reply lines after it.
    expect(scheduleManifest.task.startsWith(MORNING_BRIEF_PROMPT)).toBe(true);
    expect(scheduleManifest.task).toContain('write a short suggested reply in the brief');
    expect(scheduleManifest.task).toContain('Do not send or save anything');
    expect(scheduleManifest.task).not.toContain('Draft a reply');
    expect(scheduleManifest.task).not.toContain('Needs your OK');
    expect(scheduleManifest.task).toContain('Travessa das Gaivotas 4, 1200-000 Lisboa');
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
      'GP appointment Thursday, October 22, 2026, 09:30 at Brightwater Family Clinic with Dra. Helena Rocha',
    );
    expect(noteBody(world, 'short-term-rental')).toContain('Travessa das Gaivotas 4, 1200-000 Lisboa, in Chiado');
  });
});
