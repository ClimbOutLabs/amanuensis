import { buildDemoWorld, DEMO_MARKER } from '../../../../src/cli/demoSeed/world';
import { PersonaContentSchema } from '../../../../src/schemas/persona';
import { PersonalizationProfileContentSchema } from '../../../../src/schemas/personalization';

const base = { timeZone: 'Europe/Madrid', modelName: 'demo-provider/demo-model', runCodeAvailable: true };

describe('buildDemoWorld', () => {
  it('anchors every date to today in the user zone', () => {
    // 23:30 UTC on Oct 14 is already Oct 15 in Madrid.
    const world = buildDemoWorld({ ...base, now: new Date('2026-10-14T23:30:00Z') });
    const byKey = Object.fromEntries(world.notes.map(note => [note.key, note.body]));
    expect(world.day).toBe('2026-10-15');
    expect(byKey['appointment-today']).toContain('Appointment today, Thursday, October 15, at 4:00 pm');
    expect(byKey['week-overview']).toContain('- Friday, October 16: return the library books.');
    expect(byKey['project-balcony']).toContain('planned for Saturday, October 17');
  });

  it('keeps errands on sensible days and lists them in date order', () => {
    const world = buildDemoWorld({ ...base, now: new Date('2026-10-15T09:00:00Z') });
    const overview = world.notes
      .find(note => note.key === 'week-overview')
      ?.body.split('\n')
      .slice(1);
    expect(overview).toEqual([
      '- Thursday, October 15: 4:00 pm appointment with Dr. Halloran at Hospital Clinic, Barcelona.',
      '- Friday, October 16: return the library books.',
      '- Saturday, October 17: buy a larger pot for the basil.',
      '- Sunday, October 18: call Teo about the Lisbon dates.',
      '- Monday, October 19: team sync at 10:00 in the Poblenou office.',
      '- Tuesday, October 20: pay the quarterly utility bill.',
    ]);
  });

  it('moves the dated content when the day moves', () => {
    const first = buildDemoWorld({ ...base, now: new Date('2026-10-15T09:00:00Z') });
    const later = buildDemoWorld({ ...base, now: new Date('2026-10-20T09:00:00Z') });
    expect(later.day).toBe('2026-10-20');
    expect(later.notes.find(note => note.key === 'appointment-today')?.body).toContain('Tuesday, October 20');
    expect(later.notes.find(note => note.key === 'appointment-today')?.body).not.toContain('October 15');
    // Undated notes stay byte-identical, which is what lets a re-seed leave them alone.
    expect(later.notes.find(note => note.key === 'style')).toEqual(first.notes.find(note => note.key === 'style'));
  });

  it('plans the leave time from the route and the 15-minutes-early rule', () => {
    const world = buildDemoWorld({ ...base, now: new Date('2026-10-15T09:00:00Z') });
    expect(world.briefing.finalText).toContain('Leave by 3:15 pm');
    expect(world.briefing.routeResult.duration_min).toBe(16);
  });

  it('produces content the real schemas accept', () => {
    const world = buildDemoWorld({ ...base, now: new Date('2026-10-15T09:00:00Z') });
    expect(PersonaContentSchema.safeParse(world.persona).success).toBe(true);
    expect(PersonalizationProfileContentSchema.safeParse(world.profile).success).toBe(true);
    expect(world.scheduleManifest).toMatchObject({ cron: '30 7 * * *', timezone: 'Europe/Madrid', status: 'active' });
  });

  it('is clearly fictional: example.com addresses only, neighborhoods not addresses', () => {
    const world = buildDemoWorld({ ...base, now: new Date('2026-10-15T09:00:00Z') });
    const everything = JSON.stringify(world);
    const emails = everything.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) {
      expect(email.endsWith('@example.com')).toBe(true);
    }
    expect(everything).not.toMatch(/(\+\d{1,3}[\s-]?)?\(?\d{3}\)?[\s-]\d{3}[\s-]\d{2,4}/);
    expect(world.profile.user_profile).toContain(DEMO_MARKER);
  });

  it('tells the agent what to do about a PDF with and without a sandbox', () => {
    const now = new Date('2026-10-15T09:00:00Z');
    expect(buildDemoWorld({ ...base, now }).persona.instructions).toContain('run_code');
    const without = buildDemoWorld({ ...base, now, runCodeAvailable: false });
    expect(without.persona.instructions).not.toContain('run_code');
    expect(without.persona.instructions).toContain('not available on this server');
  });
});
