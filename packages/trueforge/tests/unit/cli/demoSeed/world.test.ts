import {
  DRAFT_EMAIL_TOOL_NAME,
  SEND_DRAFT_TOOL_NAME,
  UPDATE_DRAFT_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/email/gmail/toolContract';
import type { CalendarDay } from '@truefoundry/trueforge-core/core/util/calendarDay';
import { dayInZone, parseDemoDay, STORY, weekdayOffset } from '../../../../src/cli/demoSeed/storyDays.mjs';
import {
  buildDemoWorld,
  DEFAULT_DEMO_TIME_ZONE,
  DEMO_BRIEF_TASK,
  DEMO_USER_PROFILE,
} from '../../../../src/cli/demoSeed/world';
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

  // The demo brief is the owner's own Personal Intelligence Briefing text. Drafts are written in the
  // chat itself, never as email drafts, and nothing is sent or changed on the calendar.
  it('seeds the Personal Intelligence Briefing as the Morning brief task', () => {
    const { scheduleManifest } = worldOn(MONDAY, DEFAULT_DEMO_TIME_ZONE);
    const { task } = scheduleManifest;

    expect(scheduleManifest).toMatchObject({ cron: '30 7 * * *', timezone: 'Europe/Lisbon', status: 'active' });
    // The brief text comes first, word for word; the seed adds only the travel-from-home line after it.
    expect(task.startsWith(DEMO_BRIEF_TASK)).toBe(true);
    expect(
      task.endsWith('Work out travel from my place, Travessa das Gaivotas 4, 1200-147 Lisboa, unless I say otherwise.'),
    ).toBe(true);
    // One fragment per section, so a dropped or reworded section fails here.
    for (const fragment of [
      'Run the Morning Brief as a Personal Intelligence Briefing, an OpenUI dashboard, adaptive, never a text dump.',
      'Do this, in order:',
      "1. EMAIL: check what came in since yesterday's brief (inbox).",
      'List what needs me, most important first, one line each: who, what they want, and by when.',
      'Compare with memory to see if you can help Maya in any way.',
      '2. DRAFT REPLIES: for each email that needs an answer, write a draft reply in my voice and show it in the chat.',
      'Do not create email drafts in the mailbox. Do not send anything.',
      '3. APPOINTMENTS I TRAVEL TO: for each event with an address, tell me when to leave',
      'Add a buffer of 10 minutes.',
      "4. BRIEFING FOR EACH APPOINTMENT: who I'm meeting, what we last emailed about, anything I promised them",
      'Give me 2 or 3 talking points, and anything I need to bring.',
      '5. TOMORROW AT A GLANCE: anything early tomorrow I should prepare for today.',
      'Do not add opinions from personas or anyone else.',
      'Never send email or change my calendar during the brief.',
      'put it on my "Needs your OK" list.',
      'PERSONAL INTELLIGENCE:',
      'Personal detail comes only from what I know about Maya (memory/profile), never from a search.',
      'Weave what I know about Maya into every briefing: her life context, relationships, plans, and preferences.',
      'PRIVACY SPINE: the brief is private and can say anything. Drafts are in her voice, carry only recipient-relevant facts, and never send. Nothing escapes.',
      'Surface the single most important actionable item first, on its own highlighted card, never buried.',
      'OUTPUT: write the dashboard in your reply as an openui block (read the OpenUI instructions first; there is no dashboard tool). Draw each route once.',
      'Sections: header, 📥 Email table, 📝 Drafts, 📅 Calendar, 🧭 Travel, 🎯 Briefing per appointment, 🔭 Tomorrow, ✅ Needs your OK, with color-coded priority badges and emoji markers. Adapt: drop empty sections, never render filler. Plain, direct words; no flowery filler; no em dashes. The reply holds only the dashboard: no notes about what you are doing or planning, no text before or after the block.',
    ]) {
      expect(task).toContain(fragment);
    }
    // The five numbered sections stay in the owner's order.
    const headers = [
      '1. EMAIL:',
      '2. DRAFT REPLIES:',
      '3. APPOINTMENTS I TRAVEL TO:',
      '4. BRIEFING FOR EACH APPOINTMENT:',
      '5. TOMORROW AT A GLANCE:',
    ];
    const positions = headers.map(header => task.indexOf(header));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // The old suggested-reply line is gone; the brief text covers drafts itself.
    expect(task).not.toContain('write a short suggested reply in the brief');
    // The brief never consults personas or invents their opinions.
    for (const fragment of ['personas I have configured', 'Let them be judge', 'Dont draft emails']) {
      expect(task).not.toContain(fragment);
    }
    for (const tool of [DRAFT_EMAIL_TOOL_NAME, UPDATE_DRAFT_TOOL_NAME, SEND_DRAFT_TOOL_NAME]) {
      expect(task).not.toContain(tool);
    }
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
      expect(space.id.startsWith('maya-')).toBe(true);
    }
    expect(world.profile.user_profile).toBe(DEMO_USER_PROFILE);
  });

  it('gives the assistant a name, a character and a voice, with learning on', () => {
    const { profile, agentSpec } = worldOn(MONDAY);

    expect(profile.assistant_name).toBe('Nata');
    expect(profile.assistant_identity).toContain('Have opinions.');
    expect(profile.assistant_identity).toContain('Come back with answers, not questions');
    expect(profile.assistant_identity).toContain('Never preachy, never flowery.');
    expect(profile.voice_guidance).toBe('Warm, friendly, honest, direct and caring.');
    expect(profile.learning_enabled).toBe(true);
    expect(profile.assistant_identity).toContain('Vibe\nBest friend who knows where to look.');
    expect(agentSpec.instructions).toContain('You are Nata');
    expect(agentSpec.instructions).toContain('Warm, friendly, honest, direct and caring.');
  });

  it('never tells the assistant that Maya or her world is made up', () => {
    const world = buildDemoWorld({ today: MONDAY, timeZone: 'Europe/Lisbon', modelName: 'provider/model' });

    expect(JSON.stringify(world)).not.toMatch(/demo|synthetic|fictional|invented|made up|not real/i);
  });

  it('turns the sandbox on for the agent and tells every voice to degrade to plain text', () => {
    const world = worldOn(MONDAY);

    expect(world.agentSpec.config?.sandbox?.enabled).toBe(true);
    expect(world.agentSpec.config?.context_management?.large_tool_response?.enabled).toBe(false);
    for (const text of [world.agentSpec.instructions, ...world.personas.map(persona => persona.content.instructions)]) {
      expect(text).toContain('run_code');
      expect(text).toContain('If run_code is not available');
      expect(text).toContain('read them with the email and calendar tools');
      expect(text).toContain(
        'fetch it with the attachment tool; if it was not fetched, say that only the email text was read',
      );
      expect(text).toContain('list the recent messages and look through them instead of repeating the same words');
      expect(text).not.toContain('Google');
      expect(text).toContain('leave every send for her OK');
      expect(text).toContain(
        'make it first on sensible assumptions and say what you assumed; then ask, in one short message, for what you still need. Never ask her to confirm what she already said.',
      );
      expect(text).toContain('you cannot order, pay, book or ship, so never offer to');
      expect(text).toContain(
        'If a tool fails or a service is not connected, say so plainly and stop there; never invent what it would have returned.',
      );
    }
    expect(world.agentSpec.instructions).toContain(
      'Your reply holds only the answer for the person. If a tool fails or a service is not connected',
    );
  });

  it('books the GP in the tasks and starts trips from the rental', () => {
    const world = worldOn(MONDAY);

    expect(tasksBody(world)).toContain(
      'GP appointment Thursday, October 29, 2026, 09:30 at Brightwater Family Clinic with Dra. Helena Rocha',
    );
    expect(noteBody(world, 'short-term-rental')).toContain('Travessa das Gaivotas 4, 1200-147 Lisboa, in Chiado');
  });
});
