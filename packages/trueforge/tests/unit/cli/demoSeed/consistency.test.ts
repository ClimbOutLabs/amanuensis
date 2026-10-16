import { buildDemoWorld } from '../../../../src/cli/demoSeed/world';

const WORLD = buildDemoWorld({
  today: { year: 2026, month: 10, day: 26 },
  timeZone: 'Europe/Lisbon',
  modelName: 'demo/model',
});

const LISBON = { latitude: 38.7223, longitude: -9.1393 };
/** Portugal's clocks went back on Sunday Oct 25, 2026, so every date below is on UTC+0. */
const MINUTES_PER_DAY = 1440;

/** Sunrise and sunset in minutes after local midnight (NOAA general solar position, UTC+0). */
function sunTimes({ month, day }: { month: number; day: number }): { sunrise: number; sunset: number } {
  const dayOfYear = Math.round((Date.UTC(2026, month - 1, day) - Date.UTC(2026, 0, 0)) / 86_400_000);
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  const equationOfTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));
  const declination =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  const latitude = (LISBON.latitude * Math.PI) / 180;
  const hourAngle =
    (Math.acos(
      Math.cos((90.833 * Math.PI) / 180) / (Math.cos(latitude) * Math.cos(declination)) -
        Math.tan(latitude) * Math.tan(declination),
    ) *
      180) /
    Math.PI;
  const noon = 720 - 4 * LISBON.longitude - equationOfTime;
  return { sunrise: (noon - 4 * hourAngle) % MINUTES_PER_DAY, sunset: (noon + 4 * hourAngle) % MINUTES_PER_DAY };
}

function minutes(clock: string): number {
  const [hours, mins] = clock.split(':').map(Number);
  return (hours ?? 0) * 60 + (mins ?? 0);
}

function library(persona: string): string {
  return (WORLD.personas.find(candidate => candidate.content.display_name === persona)?.knowledge ?? [])
    .map(document => document.text)
    .join('\n');
}

/** The start time Theo's series plan gives a session, e.g. `16:40` for the line `Miradouro da Graça golden hour, 16:40 to 18:10`. */
function sessionStart(label: string): string {
  const start = new RegExp(`${label}, (\\d{1,2}:\\d\\d) to`).exec(library('Theo'))?.[1];
  if (start === undefined) {
    throw new Error(`No session line for ${label}`);
  }
  return start.padStart(5, '0');
}

describe('the light on the photo sessions', () => {
  it.each([
    ['Graça golden hour', 'Miradouro da Graça golden hour', { month: 10, day: 31 }],
    ['Belém golden hour', 'Belém golden hour', { month: 11, day: 7 }],
  ])('starts the %s 45 to 70 minutes before the real Lisbon sunset', (_label, session, date) => {
    const lead = sunTimes(date).sunset - minutes(sessionStart(session));

    expect(lead).toBeGreaterThanOrEqual(45);
    expect(lead).toBeLessThanOrEqual(70);
  });

  it('starts the Alfama sunrise session after the real sunrise', () => {
    const sunrise = sunTimes({ month: 10, day: 30 }).sunrise;

    expect(minutes(sessionStart('Alfama sunrise'))).toBeGreaterThan(sunrise);
    expect(minutes(sessionStart('Alfama sunrise')) - sunrise).toBeLessThan(30);
  });

  it('speaks of light relative to sunset, never at a fixed clock time', () => {
    const guide = library('Theo');

    expect(guide).toContain('about an hour before sunset');
    expect(guide).not.toMatch(/sunset (is|at) (around|about)? ?\d/i);
  });
});

function tasks(): string {
  return WORLD.spaces.find(space => space.content.name === 'Tasks')?.content.body ?? '';
}

describe('the third photo session', () => {
  it('is Belém in the tasks, the library and the memories', () => {
    const series = WORLD.notes.find(note => note.key === 'photo-series')?.body ?? '';

    expect(tasks()).toContain('Belém golden hour');
    expect(library('Theo')).toContain('3. Belém golden hour');
    expect(series).toContain('Belém');
    expect(series).toContain('Mouraria as an optional extra');
  });

  it('keeps Mouraria only as an optional extra in the series plan', () => {
    const plan = library('Theo').split('## Planned sessions')[1] ?? '';
    const [sessions = '', extras = ''] = plan.split('## Optional extras');

    expect(sessions).not.toContain('Mouraria');
    expect(extras).toContain('Mouraria afternoon, an optional extra spot');
  });
});

describe('the rest of the world agrees with itself', () => {
  it('uses one camera: an interchangeable-lens body, since a new lens is waiting for pickup', () => {
    const everything = JSON.stringify(WORLD);

    expect(everything).not.toContain('X100V');
    expect(everything).toContain('X-T5');
    expect(everything).toContain('XF 23mm');
  });

  it('is due to pick up the lens before the first photo session, and finishes the viewings by their due date', () => {
    expect(tasks()).toContain('Pick up the 35mm-equivalent camera lens - due Thursday, October 29');
    expect(tasks()).toContain('Tour apartments (in progress) - due Thursday, October 29');
  });
});
