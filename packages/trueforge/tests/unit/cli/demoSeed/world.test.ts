import {
  DRAFT_EMAIL_TOOL_NAME,
  SEND_DRAFT_TOOL_NAME,
  UPDATE_DRAFT_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/email/gmail/toolContract';
import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import type { CalendarDay } from '@truefoundry/trueforge-core/core/util/calendarDay';
import { dayInZone, parseDemoDay, STORY, weekdayOffset } from '../../../../src/cli/demoSeed/storyDays.mjs';
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
  return parseDemoDay(text);
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

const SEED_DAYS = ['2026-10-19', '2026-10-22', '2026-10-25'];

/** The calendar day `offset` days after `seedDay`, formatted the way the seed writes it. */
function afterSeedDay({
  seedDay,
  offset,
  options,
}: {
  seedDay: string;
  offset: number;
  options: Intl.DateTimeFormatOptions;
}): string {
  const [year = 0, month = 0, dayOfMonth = 0] = seedDay.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(
    new Date(Date.UTC(year, month - 1, dayOfMonth + offset, 12)),
  );
}

const longAfter = (seedDay: string, offset: number): string =>
  afterSeedDay({ seedDay, offset, options: { weekday: 'long', month: 'long', day: 'numeric' } });
const monthDayAfter = (seedDay: string, offset: number): string =>
  afterSeedDay({ seedDay, offset, options: { month: 'short', day: 'numeric' } });
const weekdayAfter = (seedDay: string, offset: number): string =>
  afterSeedDay({ seedDay, offset, options: { weekday: 'long' } });

describe('buildDemoWorld dates', () => {
  it.each(SEED_DAYS)(
    'counts every date from the seed day %s, with the GP visit on a weekday three days ahead',
    seedDay => {
      const body = tasksBody(worldOn(day(seedDay)));
      const gpOffset = weekdayOffset({ today: day(seedDay), offset: STORY.GP_VISIT_EARLIEST });

      expect(body).toContain(`GP appointment ${longAfter(seedDay, gpOffset)}, 2026, 09:30`);
      expect(body).toContain(`Appointment ${monthDayAfter(seedDay, 2)}, 10:00`);
      expect(body).toContain(`Pick up the 35mm-equivalent camera lens - due ${longAfter(seedDay, 3)}`);
      expect(body).toContain('- [ ] Find English-speaking GP (in progress)');
      expect(body).not.toContain('- [x] Find English-speaking GP');
    },
  );

  it.each(SEED_DAYS)('dates what is finished before the seed day %s', seedDay => {
    expect(tasksBody(worldOn(day(seedDay)))).toContain(`- [x] Get NIF (tax number) - done ${longAfter(seedDay, -8)}`);
  });

  it('dates the GP visit note with the year it falls in, across a year end', () => {
    const note = tasksBody(worldOn(day('2026-12-31')))
      .split('\n')
      .find(line => line.includes('GP appointment'));
    expect(note).toContain('GP appointment Monday, January 4, 2027, 09:30');

    const nextYear = tasksBody(worldOn(day('2027-01-02')));
    expect(nextYear).toContain('GP appointment Tuesday, January 5, 2027, 09:30');
  });

  it('keeps the same tasks on the same day, and every memory note but the meetup when the day moves', () => {
    const first = worldOn(day('2026-10-19'));
    const later = worldOn(day('2026-11-02'));

    expect(tasksBody(worldOn(day('2026-10-19')))).toBe(tasksBody(first));
    expect(later.notes.filter(note => note.key !== 'newcomers')).toEqual(
      first.notes.filter(note => note.key !== 'newcomers'),
    );
    expect(noteBody(first, 'newcomers')).toContain(
      `${weekdayAfter('2026-10-19', 10)}, ${monthDayAfter('2026-10-19', 10)} at Café do Cais`,
    );
    expect(noteBody(later, 'newcomers')).toContain(
      `${weekdayAfter('2026-11-02', 10)}, ${monthDayAfter('2026-11-02', 10)} at Café do Cais`,
    );
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
    for (const tool of [DRAFT_EMAIL_TOOL_NAME, UPDATE_DRAFT_TOOL_NAME, SEND_DRAFT_TOOL_NAME]) {
      expect(scheduleManifest.task).not.toContain(tool);
    }
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
      'GP appointment Thursday, October 29, 2026, 09:30 at Brightwater Family Clinic with Dra. Helena Rocha',
    );
    expect(noteBody(world, 'short-term-rental')).toContain('Travessa das Gaivotas 4, 1200-000 Lisboa, in Chiado');
  });
});
